import { listAll, type TransactDb } from './table-utils';
import { hanjiEnvFlag, hanjiEnvValue } from './hanji-compat';
export { listAll, nowIso } from './table-utils';

export const MCP_SUPPORTED_SCOPES = [
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'comments:read',
  'comments:write',
  'files:read',
  'files:write',
  'workspace:read',
] as const;

export const MCP_DEFAULT_SCOPES = [
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'comments:read',
  'comments:write',
  'workspace:read',
];

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180;
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
const CONSENT_REQUEST_TTL_SECONDS = 10 * 60;
export const MCP_DCR_CLIENT_IDLE_TTL_SECONDS = 60 * 60 * 24 * 90;

export interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<{ items?: T[]; hasMore?: boolean }>;
}

export interface TableRef<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface DbRef extends TransactDb {
  table<T>(name: string): TableRef<T>;
}

export interface McpOAuthClient {
  id: string;
  clientId: string;
  clientName?: string | null;
  redirectUris?: string[] | null;
  grantTypes?: string[] | null;
  responseTypes?: string[] | null;
  tokenEndpointAuthMethod?: string | null;
  clientUri?: string | null;
  logoUri?: string | null;
  status?: string | null;
  registeredBy?: string | null;
  lastUsedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpOAuthConsentRequest {
  typ: 'mcp_oauth_consent';
  iss: string;
  aud: string;
  sub: string;
  clientId: string;
  redirectUri: string;
  state: string;
  resource: string;
  requestedScopes: string[];
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  iat: number;
  exp: number;
  nonce: string;
}

export interface McpOAuthGrant {
  id: string;
  userId: string;
  clientId: string;
  clientName?: string | null;
  resource: string;
  scopes?: string[] | null;
  workspaceAccess?: string | null;
  workspaceIds?: string[] | null;
  pageIds?: string[] | null;
  databaseIds?: string[] | null;
  readOnly?: boolean | null;
  status?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpOAuthAuthorizationCode {
  id: string;
  codeHash: string;
  clientId: string;
  redirectUri: string;
  userId: string;
  grantId: string;
  resource: string;
  scopes?: string[] | null;
  codeChallenge: string;
  codeChallengeMethod?: string | null;
  expiresAt: string;
  consumedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface McpOAuthRefreshToken {
  id: string;
  tokenHash: string;
  grantId: string;
  userId: string;
  clientId: string;
  scopes?: string[] | null;
  resource: string;
  status?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface Workspace {
  id: string;
  organizationId?: string | null;
  name?: string | null;
  icon?: string | null;
  domain?: string | null;
  ownerId?: string | null;
}

export interface WorkspaceMember {
  id: string;
  workspaceId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
}

interface Organization {
  id: string;
  ownerId?: string | null;
}

interface OrganizationMember {
  id: string;
  organizationId: string;
  userId: string;
  status?: string | null;
}

export interface VerifiedMcpAccessToken {
  iss: string;
  aud: string;
  sub: string;
  grant_id: string;
  client_id: string;
  scope: string;
  exp: number;
  iat?: number;
  jti?: string;
}

interface FunctionLikeContext {
  request?: Request;
  env?: Record<string, unknown>;
}

const encoder = new TextEncoder();

export function secondsFromNow(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function json(data: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function jsonError(status: number, error: string, description?: string, headers?: HeadersInit) {
  return json(
    {
      error,
      error_description: description ?? error,
    },
    { status, headers },
  );
}

export function corsHeaders(request?: Request) {
  const headers = new Headers();
  const origin = request?.headers.get('Origin');
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Authorization,Content-Type,Mcp-Protocol-Version,MCP-Protocol-Version,Accept',
  );
  headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate,Mcp-Protocol-Version');
  return headers;
}

export function optionsResponse(request?: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function envValue(env: Record<string, unknown> | undefined, name: string) {
  return hanjiEnvValue(env, name);
}

export function originOf(request?: Request, env?: Record<string, unknown>) {
  const configured =
    envValue(env, 'HANJI_APP_ORIGIN') ??
    envValue(env, 'EDGEBASE_APP_ORIGIN') ??
    envValue(env, 'HANJI_MCP_PUBLIC_ORIGIN');
  if (configured) return configured.replace(/\/+$/, '');
  if (!request?.url) return 'http://localhost:8787';
  const url = new URL(request.url);
  return url.origin;
}

export function endpointUrls(context: FunctionLikeContext = {}) {
  const origin = originOf(context.request, context.env);
  return {
    origin,
    resource: `${origin}/api/functions/mcp`,
    protectedResource: `${origin}/api/functions/mcp-oauth-protected-resource`,
    authorizationServer: `${origin}/api/functions/mcp-oauth-authorization-server`,
    registration: `${origin}/api/functions/mcp-oauth-register`,
    authorize: `${origin}/api/functions/mcp-oauth-authorize`,
    token: `${origin}/api/functions/mcp-oauth-token`,
    revoke: `${origin}/api/functions/mcp-oauth-revoke`,
    connections: `${origin}/api/functions/mcp-connections`,
  };
}

export function htmlPage(title: string, body: string, status = 200) {
  return new Response(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: Canvas; color: CanvasText; }
    main { max-width: 680px; margin: 0 auto; padding: 48px 20px; }
    h1 { font-size: 28px; margin: 0 0 10px; }
    p { line-height: 1.55; color: color-mix(in srgb, CanvasText 72%, transparent); }
    form { display: grid; gap: 18px; margin-top: 28px; }
    fieldset { border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 8px; padding: 16px; }
    legend { padding: 0 6px; font-weight: 650; }
    label { display: flex; gap: 10px; align-items: flex-start; margin: 10px 0; }
    .muted { color: color-mix(in srgb, CanvasText 58%, transparent); font-size: 14px; }
    .actions { display: flex; gap: 10px; justify-content: flex-end; }
    button { appearance: none; border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 999px; padding: 10px 16px; background: Canvas; color: CanvasText; font: inherit; cursor: pointer; }
    button.primary { background: CanvasText; color: Canvas; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function requestBody(request?: Request) {
  if (!request) return {};
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed = await request.json().catch(() => ({}));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  }
  const text = await request.text();
  const params = new URLSearchParams(text);
  return Object.fromEntries(params.entries());
}

export function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

export function stringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[\s,]+/g).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function normalizeScopes(value: unknown, fallback = MCP_DEFAULT_SCOPES) {
  const requested = stringList(value);
  const source = requested.length ? requested : fallback;
  const supported = new Set<string>(MCP_SUPPORTED_SCOPES);
  return Array.from(new Set(source.filter((scope) => supported.has(scope))));
}

// OAuth distinguishes an omitted scope (the server may apply documented
// defaults) from an explicitly empty or unsupported scope. Keep that
// distinction here so an empty consent can never turn back into the broad
// default grant.
export function validateMcpScopes(value: unknown, fallback = MCP_DEFAULT_SCOPES) {
  if (value === undefined || value === null) {
    return normalizeScopes(fallback, []);
  }
  const requested = stringList(value);
  if (!requested.length) {
    throw new Error('scope must include at least one supported MCP scope.');
  }
  const supported = new Set<string>(MCP_SUPPORTED_SCOPES);
  const unsupported = Array.from(new Set(requested.filter((scope) => !supported.has(scope))));
  if (unsupported.length) {
    throw new Error(`Unsupported MCP scope: ${unsupported.join(', ')}.`);
  }
  return Array.from(new Set(requested));
}

export function validateMcpClientMetadata(input: Record<string, unknown>) {
  const redirectUris = Array.from(new Set(stringList(input.redirect_uris ?? input.redirectUris)));
  if (!redirectUris.length) throw new Error('redirect_uris is required.');
  if (redirectUris.length > 10) throw new Error('redirect_uris cannot contain more than 10 entries.');
  for (const redirectUri of redirectUris) {
    if (redirectUri.length > 2_048) throw new Error('redirect_uri is too long.');
    validateRedirectUri(null, redirectUri);
  }

  const requestedGrantTypes = input.grant_types === undefined && input.grantTypes === undefined
    ? ['authorization_code', 'refresh_token']
    : stringList(input.grant_types ?? input.grantTypes);
  const grantTypes = Array.from(new Set(requestedGrantTypes));
  if (!grantTypes.length || !grantTypes.includes('authorization_code')) {
    throw new Error('grant_types must include authorization_code.');
  }
  if (grantTypes.some((value) => value !== 'authorization_code' && value !== 'refresh_token')) {
    throw new Error('grant_types contains an unsupported value.');
  }

  const requestedResponseTypes = input.response_types === undefined && input.responseTypes === undefined
    ? ['code']
    : stringList(input.response_types ?? input.responseTypes);
  const responseTypes = Array.from(new Set(requestedResponseTypes));
  if (responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    throw new Error('response_types must be exactly ["code"].');
  }

  const tokenEndpointAuthMethod = stringValue(
    input.token_endpoint_auth_method ?? input.tokenEndpointAuthMethod,
    'none',
  );
  if (tokenEndpointAuthMethod !== 'none') {
    throw new Error('token_endpoint_auth_method must be none.');
  }

  const clientName = stringValue(input.client_name ?? input.clientName, 'MCP client');
  if (clientName.length > 200) throw new Error('client_name is too long.');
  return { redirectUris, grantTypes, responseTypes, tokenEndpointAuthMethod, clientName };
}

export function readOnlyFromScopes(scopes: string[]) {
  return !scopes.some((scope) => scope.endsWith(':write'));
}

export async function findClient(db: DbRef, clientId: string) {
  const clients = await listAll(
    db.table<McpOAuthClient>('mcp_oauth_clients').where('clientId', '==', clientId),
  );
  return clients.find((client) => mcpOAuthClientIsActive(client)) ?? null;
}

export function mcpOAuthClientIsActive(client: McpOAuthClient, nowMs = Date.now()) {
  if ((client.status ?? 'active') !== 'active') return false;
  const activity = client.lastUsedAt ?? client.updatedAt ?? client.createdAt;
  if (!activity) return true;
  const activityMs = Date.parse(activity);
  if (!Number.isFinite(activityMs)) return false;
  return nowMs - activityMs <= MCP_DCR_CLIENT_IDLE_TTL_SECONDS * 1000;
}

export async function accessibleWorkspaces(db: DbRef, userId: string) {
  const workspaces = db.table<Workspace>('workspaces');
  const members = db.table<WorkspaceMember>('workspace_members');
  const owned = await listAll(workspaces.where('ownerId', '==', userId));
  const memberships = await listAll(members.where('userId', '==', userId));
  const candidates = new Map<string, Workspace>();
  for (const workspace of owned) candidates.set(workspace.id, workspace);
  for (const membership of memberships) {
    const role = membership.role ?? 'member';
    if (!['owner', 'admin', 'member', 'guest'].includes(role)) continue;
    const workspace = await workspaces.getOne(membership.workspaceId).catch(() => null);
    if (workspace) candidates.set(workspace.id, workspace);
  }

  // Workspace membership alone must not bypass organization lifecycle state.
  // A deactivated organization member may retain a stale workspace_members row,
  // but no longer receives workspace metadata through hosted MCP.
  const organizationMemberships = await listAll(
    db.table<OrganizationMember>('organization_members').where('userId', '==', userId),
  ).catch(() => []);
  const activeOrganizationIds = new Set(
    organizationMemberships
      .filter((member) => (member.status ?? 'active') === 'active')
      .map((member) => member.organizationId),
  );
  const byId = new Map<string, Workspace>();
  for (const workspace of candidates.values()) {
    if (!workspace.organizationId) {
      byId.set(workspace.id, workspace);
      continue;
    }
    const organization = await db.table<Organization>('organizations')
      .getOne(workspace.organizationId)
      .catch(() => null);
    if (organization && (organization.ownerId === userId || activeOrganizationIds.has(workspace.organizationId))) {
      byId.set(workspace.id, workspace);
    }
  }
  return Array.from(byId.values()).sort((a, b) =>
    String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id.localeCompare(b.id),
  );
}

export async function grantAccessibleWorkspaces(db: DbRef, grant: McpOAuthGrant) {
  const rows = await accessibleWorkspaces(db, grant.userId);
  if ((grant.workspaceAccess ?? 'all_accessible') !== 'selected') return rows;
  const allowed = new Set((grant.workspaceIds ?? []).map(String));
  return rows.filter((workspace) => allowed.has(workspace.id));
}

// Revoke the grant and every currently usable refresh token in one database
// transaction. Rotated/expired rows are already unusable; revoking the grant
// also invalidates any access token minted immediately before reuse detection.
export async function revokeMcpGrantFamily(
  db: DbRef,
  grantId: string,
  revokedBy: string,
  now = new Date().toISOString(),
) {
  const rows = await listAll(
    db.table<McpOAuthRefreshToken>('mcp_oauth_refresh_tokens').where('grantId', '==', grantId),
  );
  const activeRows = rows.filter(
    (row) => (row.status ?? 'active') === 'active' && !row.revokedAt,
  );
  // EdgeBase caps one transact call at 500 operations. The healthy invariant
  // is one active token per grant, but cap the first atomic batch defensively
  // so legacy/corrupt families cannot prevent the grant itself being revoked.
  const firstBatch = activeRows.slice(0, 499);
  await db.transact([
    {
      table: 'mcp_oauth_grants',
      op: 'update',
      id: grantId,
      data: { status: 'revoked', revokedAt: now, revokedBy },
    },
    ...firstBatch.map((row) => ({
      table: 'mcp_oauth_refresh_tokens',
      op: 'update' as const,
      id: row.id,
      data: { status: 'revoked', revokedAt: now, revokedBy },
    })),
  ]);
  for (let index = firstBatch.length; index < activeRows.length; index += 500) {
    await db.transact(activeRows.slice(index, index + 500).map((row) => ({
      table: 'mcp_oauth_refresh_tokens',
      op: 'update' as const,
      id: row.id,
      data: { status: 'revoked', revokedAt: now, revokedBy },
    })));
  }
}

export function grantIsActive(grant: McpOAuthGrant | null | undefined) {
  if (!grant || (grant.status ?? 'active') !== 'active' || grant.revokedAt) return false;
  if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return false;
  return true;
}

export function publicGrant(grant: McpOAuthGrant) {
  return {
    id: grant.id,
    clientId: grant.clientId,
    clientName: grant.clientName ?? 'MCP client',
    resource: grant.resource,
    scopes: grant.scopes ?? [],
    workspaceAccess: grant.workspaceAccess ?? 'all_accessible',
    workspaceIds: grant.workspaceIds ?? [],
    pageIds: grant.pageIds ?? [],
    databaseIds: grant.databaseIds ?? [],
    readOnly: grant.readOnly === true,
    status: grant.revokedAt ? 'revoked' : grant.status ?? 'active',
    expiresAt: grant.expiresAt ?? null,
    lastUsedAt: grant.lastUsedAt ?? null,
    createdAt: grant.createdAt,
    updatedAt: grant.updatedAt,
  };
}

export function randomToken(prefix: string) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64UrlEncode(bytes)}`;
}

export async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function verifyPkce(verifier: string, challenge: string, method: string | null | undefined) {
  if (!verifier || !challenge) return false;
  const normalizedMethod = (method || 'S256').toUpperCase();
  if (normalizedMethod === 'S256') return await sha256Base64Url(verifier) === challenge;
  if (normalizedMethod === 'PLAIN') return verifier === challenge;
  return false;
}

export async function issueAccessToken(
  env: Record<string, unknown> | undefined,
  request: Request | undefined,
  grant: McpOAuthGrant,
  scopes: string[],
) {
  const urls = endpointUrls({ request, env });
  const now = Math.floor(Date.now() / 1000);
  const payload: VerifiedMcpAccessToken = {
    iss: urls.origin,
    aud: grant.resource || urls.resource,
    sub: grant.userId,
    grant_id: grant.id,
    client_id: grant.clientId,
    scope: scopes.join(' '),
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomToken('mcp_jti'),
  };
  return {
    accessToken: await signJwt(payload, env, request),
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  };
}

export async function issueRefreshToken(
  db: DbRef,
  grant: McpOAuthGrant,
  scopes: string[],
) {
  const prepared = await prepareRefreshToken(grant, scopes);
  await db.table<McpOAuthRefreshToken>('mcp_oauth_refresh_tokens').insert(prepared.data);
  return { token: prepared.token, expiresAt: prepared.expiresAt };
}

export async function prepareRefreshToken(grant: McpOAuthGrant, scopes: string[]) {
  const token = randomToken('mcp_refresh');
  const expiresAt = secondsFromNow(REFRESH_TOKEN_TTL_SECONDS);
  return {
    token,
    expiresAt,
    data: {
      tokenHash: await sha256Base64Url(token),
      grantId: grant.id,
      userId: grant.userId,
      clientId: grant.clientId,
      scopes,
      resource: grant.resource,
      status: 'active',
      expiresAt,
    } satisfies Partial<McpOAuthRefreshToken>,
  };
}

export async function signJwt(
  payload: object,
  env: Record<string, unknown> | undefined,
  request?: Request,
) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = await hmacSha256Base64Url(input, jwtSecret(env, request));
  return `${input}.${signature}`;
}

export async function signConsentRequest(
  env: Record<string, unknown> | undefined,
  request: Request | undefined,
  input: Omit<McpOAuthConsentRequest, 'typ' | 'iss' | 'aud' | 'iat' | 'exp' | 'nonce'>,
) {
  const urls = endpointUrls({ request, env });
  const now = Math.floor(Date.now() / 1000);
  const payload: McpOAuthConsentRequest = {
    typ: 'mcp_oauth_consent',
    iss: urls.origin,
    aud: urls.authorize,
    iat: now,
    exp: now + CONSENT_REQUEST_TTL_SECONDS,
    nonce: randomToken('mcp_consent'),
    ...input,
  };
  return signJwt(payload, env, request);
}

export async function verifyConsentRequest(
  token: string,
  env: Record<string, unknown> | undefined,
  request?: Request,
) {
  const payload = await verifySignedJwt(token, env, request) as unknown as Partial<McpOAuthConsentRequest>;
  const urls = endpointUrls({ request, env });
  if (
    payload.typ !== 'mcp_oauth_consent' ||
    payload.iss !== urls.origin ||
    payload.aud !== urls.authorize ||
    !payload.sub ||
    !payload.clientId ||
    !payload.redirectUri ||
    !payload.resource ||
    !payload.codeChallenge ||
    payload.codeChallengeMethod !== 'S256' ||
    !payload.nonce ||
    !Array.isArray(payload.requestedScopes)
  ) {
    throw new Error('MCP consent request is invalid.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('MCP consent request has expired.');
  }
  payload.requestedScopes = validateMcpScopes(payload.requestedScopes, []);
  return payload as McpOAuthConsentRequest;
}

export async function verifyAccessToken(
  token: string,
  env: Record<string, unknown> | undefined,
  request?: Request,
) {
  const payload = await verifySignedJwt(token, env, request) as unknown as VerifiedMcpAccessToken;
  if (!payload.sub || !payload.grant_id || !payload.client_id || !payload.aud || !payload.iss) {
    throw new Error('Access token claims are incomplete.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Access token is expired.');
  }
  const resource = endpointUrls({ request, env }).resource;
  if (payload.aud !== resource) throw new Error('Access token audience is invalid.');
  return payload;
}

async function verifySignedJwt(
  token: string,
  env: Record<string, unknown> | undefined,
  request?: Request,
) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Access token is malformed.');
  const [encodedHeader, encodedPayload, signature] = parts;
  const expected = await hmacSha256Base64Url(`${encodedHeader}.${encodedPayload}`, jwtSecret(env, request));
  if (!constantTimeEqual(signature, expected)) throw new Error('Access token signature is invalid.');
  const header = JSON.parse(textFromBase64Url(encodedHeader)) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('Access token algorithm is unsupported.');
  return JSON.parse(textFromBase64Url(encodedPayload)) as Record<string, unknown>;
}

function envFlag(env: Record<string, unknown> | undefined, ...names: string[]) {
  return hanjiEnvFlag(env, ...names);
}

function jwtSecret(env: Record<string, unknown> | undefined, _request?: Request) {
  const secret =
    envValue(env, 'HANJI_MCP_OAUTH_SECRET') ??
    envValue(env, 'HANJI_MCP_JWT_SECRET') ??
    envValue(env, 'JWT_USER_SECRET') ??
    envValue(env, 'EDGEBASE_JWT_SECRET');
  if (secret) return secret;
  // The Host header is attacker-controlled (a production request can send
  // `Host: localhost`), so the dev fallback must key off a trusted server-side
  // signal only — an explicit env flag the operator sets for local/CI. Only
  // the MCP-specific flag opts in: HANJI_ALLOW_DEV_GUEST_LOGIN must NOT
  // double as this switch, or an operator enabling guest login would silently
  // make every MCP access token forgeable. With no configured secret and no
  // dev flag, fail closed: signing with a hard-coded secret in production
  // would let anyone forge access tokens.
  if (envFlag(env, 'HANJI_MCP_OAUTH_ALLOW_DEV_SECRET')) {
    return 'local-dev-mcp-oauth-secret';
  }
  throw new Error('HANJI_MCP_OAUTH_SECRET is required for hosted MCP OAuth.');
}

// Length-independent comparison of two ASCII strings (base64url signatures):
// folds every byte into an accumulator so the running time does not depend on
// where the first mismatch is, removing the timing side channel that `!==`
// (which short-circuits) would expose.
function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let index = 0; index < max; index += 1) {
    diff |= (aBytes[index] ?? 0) ^ (bBytes[index] ?? 0);
  }
  return diff === 0;
}

async function hmacSha256Base64Url(input: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return base64UrlEncode(new Uint8Array(signature));
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function textFromBase64Url(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

export function bearerToken(request?: Request) {
  const header = request?.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

export function authorizationChallenge(context: FunctionLikeContext = {}, scope = MCP_DEFAULT_SCOPES.join(' ')) {
  const urls = endpointUrls(context);
  return `Bearer resource_metadata="${urls.protectedResource}", scope="${scope}"`;
}

export function redirectWithParams(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return Response.redirect(url.toString(), 302);
}

export function validateRedirectUri(client: McpOAuthClient | null, redirectUri: string) {
  if (!redirectUri) throw new Error('redirect_uri is required.');
  const parsed = new URL(redirectUri);
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('redirect_uri must use HTTPS.');
  }
  if (parsed.hash) throw new Error('redirect_uri must not include a fragment.');
  if (parsed.username || parsed.password) throw new Error('redirect_uri must not include user information.');
  const registered = client?.redirectUris ?? [];
  if (registered.length && !registered.includes(redirectUri)) {
    throw new Error('redirect_uri is not registered for this MCP client.');
  }
}

export function authorizationCodeExpiresAt() {
  return secondsFromNow(AUTHORIZATION_CODE_TTL_SECONDS);
}

export function refreshTokenExpired(token: McpOAuthRefreshToken) {
  return !!token.expiresAt && Date.parse(token.expiresAt) <= Date.now();
}
