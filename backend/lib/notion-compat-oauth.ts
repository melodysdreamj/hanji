import {
  MCP_DEFAULT_SCOPES,
  type DbRef,
  type McpOAuthAuthorizationCode,
  type McpOAuthClient,
  type McpOAuthGrant,
  type McpOAuthRefreshToken,
  type VerifiedMcpAccessToken,
  type Workspace,
  type WorkspaceMember,
  authorizationCodeExpiresAt,
  envValue,
  grantAccessibleWorkspaces,
  grantIsActive,
  listAll,
  nowIso,
  originOf,
  randomToken,
  readOnlyFromScopes,
  refreshTokenExpired,
  revokeMcpGrantFamily,
  sha256Base64Url,
  signJwt,
  stringList,
  stringValue,
  validateMcpScopes,
  verifySignedJwt,
} from './mcp-oauth';
import { getExisting, newId } from './table-utils';
import { pageAccessRole } from './page-access';

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 180;
const CONSENT_REQUEST_TTL_SECONDS = 10 * 60;
const CONFIDENTIAL_CODE_METHOD = 'HANJI_NOTION_CONFIDENTIAL';
const CLIENTS_ENV = 'HANJI_NOTION_COMPAT_OAUTH_CLIENTS';
const SINGLE_CLIENT_ID_ENV = 'HANJI_NOTION_COMPAT_OAUTH_CLIENT_ID';
const SINGLE_CLIENT_SECRET_ENV = 'HANJI_NOTION_COMPAT_OAUTH_CLIENT_SECRET';
const SINGLE_CLIENT_SECRET_HASH_ENV = 'HANJI_NOTION_COMPAT_OAUTH_CLIENT_SECRET_HASH';
const SINGLE_CLIENT_REDIRECT_URIS_ENV = 'HANJI_NOTION_COMPAT_OAUTH_REDIRECT_URIS';
const SINGLE_CLIENT_NAME_ENV = 'HANJI_NOTION_COMPAT_OAUTH_CLIENT_NAME';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string, instanceId?: string): DbRef;
  };
}

interface StoredNotionCompatClient extends McpOAuthClient {
  clientSecretHash?: string | null;
  notionCompatClientSecretHash?: string | null;
}

interface ConfiguredClientInput {
  client_id?: unknown;
  clientId?: unknown;
  client_name?: unknown;
  clientName?: unknown;
  client_secret?: unknown;
  clientSecret?: unknown;
  client_secret_hash?: unknown;
  clientSecretHash?: unknown;
  redirect_uris?: unknown;
  redirectUris?: unknown;
}

export interface NotionCompatClientRegistration {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  secretHashes: string[];
  row?: StoredNotionCompatClient | null;
}

export interface NotionCompatAccessTokenClaims extends VerifiedMcpAccessToken {
  typ: 'hanji_notion_compat_access';
  workspace_id: string;
}

export interface NotionCompatBearerIdentity {
  id: string;
  email: string | null;
  workspaceId: string;
  scopes: string[];
  grant: McpOAuthGrant;
  claims: NotionCompatAccessTokenClaims;
}

export interface IssueNotionCompatAuthorizationCodeInput {
  userId: string;
  clientId: string;
  redirectUri: string;
  workspaceId: string;
  state?: string;
  scopes?: string[];
  resourceIds?: string[];
}

export interface NotionCompatConsentRequest {
  typ: 'hanji_notion_compat_consent';
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  requested_scopes: string[];
  iat: number;
  exp: number;
  nonce: string;
}

interface PreparedRefreshToken {
  token: string;
  expiresAt: string;
  data: Partial<McpOAuthRefreshToken>;
}

class NotionCompatOAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function compatResource(context: Pick<FunctionContext, 'request' | 'env'>) {
  return `${originOf(context.request, context.env)}/api/functions/notion/v1`;
}

function compatAuthorizeAudience(context: Pick<FunctionContext, 'request' | 'env'>) {
  return `${originOf(context.request, context.env)}/api/functions/notion-oauth-authorize`;
}

function decodeBasicCredentials(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const binary = atob(match[1]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(':');
    if (separator < 1) return null;
    return {
      clientId: decoded.slice(0, separator),
      clientSecret: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function configuredClientInputs(env: Record<string, unknown> | undefined): ConfiguredClientInput[] {
  const raw = envValue(env, CLIENTS_ENV);
  const out: ConfiguredClientInput[] = [];
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`${CLIENTS_ENV} must be valid JSON.`);
    }
    if (Array.isArray(parsed)) {
      out.push(...parsed.filter((item): item is ConfiguredClientInput => !!item && typeof item === 'object'));
    } else if (parsed && typeof parsed === 'object') {
      for (const [clientId, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') {
          out.push({ clientId, clientSecret: value });
        } else if (value && typeof value === 'object') {
          out.push({ clientId, ...(value as ConfiguredClientInput) });
        }
      }
    } else {
      throw new Error(`${CLIENTS_ENV} must be an array or object.`);
    }
  }

  const singleClientId = envValue(env, SINGLE_CLIENT_ID_ENV);
  if (singleClientId) {
    out.push({
      clientId: singleClientId,
      clientName: envValue(env, SINGLE_CLIENT_NAME_ENV),
      clientSecret: envValue(env, SINGLE_CLIENT_SECRET_ENV),
      clientSecretHash: envValue(env, SINGLE_CLIENT_SECRET_HASH_ENV),
      redirectUris: envValue(env, SINGLE_CLIENT_REDIRECT_URIS_ENV),
    });
  }
  return out;
}

async function configuredRegistration(
  env: Record<string, unknown> | undefined,
  clientId: string,
) {
  for (const input of configuredClientInputs(env)) {
    const candidateId = stringValue(input.client_id ?? input.clientId);
    if (candidateId !== clientId) continue;
    const rawSecret = stringValue(input.client_secret ?? input.clientSecret);
    const configuredHash = stringValue(input.client_secret_hash ?? input.clientSecretHash);
    return {
      clientId,
      clientName: stringValue(input.client_name ?? input.clientName, 'Hanji integration'),
      redirectUris: Array.from(new Set(stringList(input.redirect_uris ?? input.redirectUris))),
      secretHashes: Array.from(new Set([
        configuredHash,
        rawSecret ? await sha256Base64Url(rawSecret) : '',
      ].filter(Boolean))),
    };
  }
  return null;
}

async function storedClientRows(db: DbRef, clientId: string) {
  const result = await db.table<StoredNotionCompatClient>('mcp_oauth_clients')
    .where('clientId', '==', clientId)
    .page(1)
    .limit(10)
    .getList();
  return result.items ?? [];
}

async function storedClient(db: DbRef, clientId: string) {
  const rows = await storedClientRows(db, clientId);
  return rows.find((client) => (client.status ?? 'active') === 'active') ?? null;
}

/**
 * Resolves the confidential-client registration without authenticating it.
 * This is intentionally separate so an authorization/consent page can safely
 * validate client_id + redirect_uri without receiving the client secret.
 */
export async function resolveNotionCompatClientRegistration(
  db: DbRef,
  env: Record<string, unknown> | undefined,
  clientId: string,
): Promise<NotionCompatClientRegistration | null> {
  if (!clientId) return null;
  const [configured, rows] = await Promise.all([
    configuredRegistration(env, clientId),
    storedClientRows(db, clientId),
  ]);
  const row = rows.find((client) => (client.status ?? 'active') === 'active') ?? null;
  // An explicit database revocation wins over an environment registration.
  // This prevents an operator-managed secret from silently resurrecting a
  // client that an administrator disabled in Hanji.
  if (rows.length > 0 && !row) return null;
  if (!configured && !row) return null;
  const storedHash = stringValue(row?.notionCompatClientSecretHash ?? row?.clientSecretHash);
  return {
    clientId,
    clientName: configured?.clientName ?? row?.clientName ?? 'Hanji integration',
    redirectUris: Array.from(new Set([
      ...(configured?.redirectUris ?? []),
      ...(row?.redirectUris ?? []),
    ])),
    secretHashes: Array.from(new Set([
      ...(configured?.secretHashes ?? []),
      storedHash,
    ].filter(Boolean))),
    row,
  };
}

function constantTimeEqualAscii(left: string, right: string) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

async function authenticateClient(
  context: FunctionContext,
  body: Record<string, unknown>,
) {
  const basic = decodeBasicCredentials(context.request);
  const bodyClientId = stringValue(body.client_id);
  const bodySecret = stringValue(body.client_secret);
  if (basic && bodyClientId && basic.clientId !== bodyClientId) {
    throw new NotionCompatOAuthError(401, 'invalid_client', 'Client credentials do not match.');
  }
  if (basic && bodySecret && basic.clientSecret !== bodySecret) {
    throw new NotionCompatOAuthError(401, 'invalid_client', 'Client credentials do not match.');
  }
  const clientId = basic?.clientId ?? bodyClientId;
  const secret = basic?.clientSecret ?? bodySecret;
  if (!clientId || !secret) {
    throw new NotionCompatOAuthError(401, 'invalid_client', 'HTTP Basic client authentication is required.');
  }
  const db = context.admin.db('app');
  const registration = await resolveNotionCompatClientRegistration(db, context.env, clientId);
  if (!registration || registration.secretHashes.length === 0) {
    throw new NotionCompatOAuthError(401, 'invalid_client', 'Client authentication failed.');
  }
  const presentedHash = await sha256Base64Url(secret);
  if (!registration.secretHashes.some((hash) => constantTimeEqualAscii(hash, presentedHash))) {
    throw new NotionCompatOAuthError(401, 'invalid_client', 'Client authentication failed.');
  }
  return registration;
}

export function validateNotionCompatRedirectUri(
  registration: NotionCompatClientRegistration,
  redirectUri: string,
) {
  if (!redirectUri) throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri is required.');
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri is invalid.');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri must use HTTPS.');
  }
  if (parsed.hash || parsed.username || parsed.password) {
    throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri is invalid.');
  }
  if (!registration.redirectUris.includes(redirectUri)) {
    throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri is not registered for this client.');
  }
}

export async function signNotionCompatConsentRequest(
  context: Pick<FunctionContext, 'request' | 'env'>,
  input: {
    userId: string;
    clientId: string;
    redirectUri: string;
    state?: string;
    requestedScopes?: string[];
  },
) {
  const now = Math.floor(Date.now() / 1000);
  const payload: NotionCompatConsentRequest = {
    typ: 'hanji_notion_compat_consent',
    iss: originOf(context.request, context.env),
    aud: compatAuthorizeAudience(context),
    sub: input.userId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    state: input.state ?? '',
    requested_scopes: validateMcpScopes(input.requestedScopes, MCP_DEFAULT_SCOPES),
    iat: now,
    exp: now + CONSENT_REQUEST_TTL_SECONDS,
    nonce: randomToken('hanji_notion_consent'),
  };
  return signJwt(payload, context.env, context.request);
}

export async function verifyNotionCompatConsentRequest(
  context: Pick<FunctionContext, 'request' | 'env'>,
  token: string,
) {
  const payload = await verifySignedJwt(token, context.env, context.request) as unknown as Partial<NotionCompatConsentRequest>;
  if (
    payload.typ !== 'hanji_notion_compat_consent'
    || payload.iss !== originOf(context.request, context.env)
    || payload.aud !== compatAuthorizeAudience(context)
    || !payload.sub
    || !payload.client_id
    || !payload.redirect_uri
    || !payload.nonce
    || typeof payload.exp !== 'number'
    || payload.exp <= Math.floor(Date.now() / 1000)
    || !Array.isArray(payload.requested_scopes)
  ) {
    throw new Error('Notion-compatible consent request is invalid or expired.');
  }
  payload.requested_scopes = validateMcpScopes(payload.requested_scopes, []);
  return payload as NotionCompatConsentRequest;
}

async function ensureClientRow(db: DbRef, registration: NotionCompatClientRegistration) {
  if (registration.row) return registration.row;
  try {
    return await db.table<StoredNotionCompatClient>('mcp_oauth_clients').insert({
      id: newId(),
      clientId: registration.clientId,
      clientName: registration.clientName,
      redirectUris: registration.redirectUris,
      grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'],
      tokenEndpointAuthMethod: 'client_secret_basic',
      status: 'active',
      lastUsedAt: nowIso(),
    });
  } catch (error) {
    // A concurrent first authorization can win the unique client row. Re-read
    // only in that case; a continuing storage failure must stay fail-loud.
    const existing = await storedClient(db, registration.clientId).catch(() => null);
    if (existing) return existing;
    throw error;
  }
}

/**
 * Creates the one-shot code consumed by /v1/oauth/token. The caller owns the
 * authenticated consent UI; this function owns workspace access validation and
 * durable grant/code creation. Notion-compatible grants are deliberately one
 * workspace only so a token can never widen into the account-scoped MCP model.
 */
export async function issueNotionCompatAuthorizationCode(
  context: FunctionContext,
  input: IssueNotionCompatAuthorizationCodeInput,
) {
  const db = context.admin.db('app');
  const registration = await resolveNotionCompatClientRegistration(db, context.env, input.clientId);
  if (!registration) throw new NotionCompatOAuthError(400, 'unauthorized_client', 'Integration client is not registered.');
  validateNotionCompatRedirectUri(registration, input.redirectUri);
  const workspace = (await grantAccessibleWorkspaces(db, {
    id: 'authorization-check',
    userId: input.userId,
    clientId: input.clientId,
    resource: compatResource(context),
    workspaceAccess: 'selected',
    workspaceIds: [input.workspaceId],
    status: 'active',
  })).find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new NotionCompatOAuthError(400, 'invalid_scope', 'The selected workspace is not accessible.');

  const requestedResourceIds = Array.from(new Set(
    (input.resourceIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  ));
  if (requestedResourceIds.length > 1_000) {
    throw new NotionCompatOAuthError(400, 'invalid_scope', 'At most 1,000 pages or databases may be selected.');
  }
  const selectedPageIds: string[] = [];
  const selectedDatabaseIds: string[] = [];
  if (requestedResourceIds.length > 0) {
    const workspaceDb = context.admin.db('workspace', workspace.id);
    for (const resourceId of requestedResourceIds) {
      const page = await getExisting(workspaceDb.table<{
        id: string;
        workspaceId: string;
        kind?: string;
        inTrash?: boolean;
      }>('pages'), resourceId);
      if (
        !page
        || page.workspaceId !== workspace.id
        || page.inTrash
        || !(await pageAccessRole(workspaceDb, page, input.userId))
      ) {
        throw new NotionCompatOAuthError(
          400,
          'invalid_scope',
          'One or more selected pages are not accessible in the chosen workspace.',
        );
      }
      if (page.kind === 'database') selectedDatabaseIds.push(page.id);
      else selectedPageIds.push(page.id);
    }
  }

  await ensureClientRow(db, registration);
  let scopes: string[];
  try {
    scopes = validateMcpScopes(input.scopes, MCP_DEFAULT_SCOPES);
  } catch (error) {
    throw new NotionCompatOAuthError(
      400,
      'invalid_scope',
      error instanceof Error ? error.message : String(error),
    );
  }
  const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').insert({
    id: newId(),
    userId: input.userId,
    clientId: input.clientId,
    clientName: registration.clientName,
    resource: compatResource(context),
    scopes,
    workspaceAccess: 'selected',
    workspaceIds: [workspace.id],
    // Empty arrays intentionally mean the whole selected workspace. Non-empty
    // arrays activate the existing ancestor-aware resource allowlist used by
    // hosted MCP and Notion-compatible meeting-note/search paths.
    pageIds: selectedPageIds,
    databaseIds: selectedDatabaseIds,
    readOnly: readOnlyFromScopes(scopes),
    status: 'active',
  });
  const code = randomToken('hanji_notion_code');
  const expiresAt = authorizationCodeExpiresAt();
  try {
    await db.table<McpOAuthAuthorizationCode>('mcp_oauth_authorization_codes').insert({
      id: newId(),
      codeHash: await sha256Base64Url(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      userId: input.userId,
      grantId: grant.id,
      resource: grant.resource,
      scopes,
      codeChallenge: input.clientId,
      codeChallengeMethod: CONFIDENTIAL_CODE_METHOD,
      expiresAt,
      consumedAt: null,
    });
  } catch (error) {
    await revokeMcpGrantFamily(db, grant.id, 'system:authorization-code-create-failed').catch(() => undefined);
    throw error;
  }

  const redirect = new URL(input.redirectUri);
  redirect.searchParams.set('code', code);
  if (input.state !== undefined) redirect.searchParams.set('state', input.state);
  return {
    code,
    grantId: grant.id,
    workspaceId: workspace.id,
    expiresAt,
    redirectUrl: redirect.toString(),
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

function secondsFromNow(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function prepareCompatRefreshToken(grant: McpOAuthGrant, scopes: string[]): Promise<PreparedRefreshToken> {
  const token = randomToken('hanji_notion_refresh');
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
    },
  };
}

async function issueCompatAccessToken(
  context: FunctionContext,
  grant: McpOAuthGrant,
  workspaceId: string,
  scopes: string[],
) {
  const now = Math.floor(Date.now() / 1000);
  const claims: NotionCompatAccessTokenClaims = {
    typ: 'hanji_notion_compat_access',
    iss: originOf(context.request, context.env),
    aud: compatResource(context),
    sub: grant.userId,
    grant_id: grant.id,
    client_id: grant.clientId,
    workspace_id: workspaceId,
    scope: scopes.join(' '),
    iat: now,
    exp: now + ACCESS_TOKEN_TTL_SECONDS,
    jti: randomToken('hanji_notion_jti'),
  };
  return {
    token: await signJwt(claims, context.env, context.request),
    claims,
  };
}

async function activeGrantWorkspace(db: DbRef, grant: McpOAuthGrant | null | undefined) {
  if (!grantIsActive(grant)) return null;
  if (grant!.workspaceAccess !== 'selected' || (grant!.workspaceIds ?? []).length !== 1) return null;
  const workspaceId = String(grant!.workspaceIds![0]);
  if (grant!.resource.length === 0) return null;
  return (await grantAccessibleWorkspaces(db, grant!)).find((workspace) => workspace.id === workspaceId) ?? null;
}

async function ownerResponse(db: DbRef, workspace: Workspace, userId: string) {
  const members = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspace.id),
  );
  const member = members.find((candidate) => candidate.userId === userId);
  if (!member?.email) return { type: 'workspace', workspace: true };
  return {
    type: 'user',
    user: {
      object: 'user',
      id: userId,
      type: 'person',
      name: member.displayName ?? null,
      avatar_url: null,
      person: { email: member.email },
    },
  };
}

async function tokenResponse(
  db: DbRef,
  workspace: Workspace,
  grant: McpOAuthGrant,
  accessToken: string,
  refreshToken: string,
) {
  return {
    access_token: accessToken,
    token_type: 'bearer',
    refresh_token: refreshToken,
    bot_id: grant.id,
    workspace_icon: workspace.icon ?? null,
    workspace_name: workspace.name ?? null,
    workspace_id: workspace.id,
    owner: await ownerResponse(db, workspace, grant.userId),
    duplicated_template_id: null,
    request_id: newId(),
  };
}

async function authorizationCodeGrant(
  context: FunctionContext,
  registration: NotionCompatClientRegistration,
  body: Record<string, unknown>,
) {
  const code = stringValue(body.code);
  const redirectUri = stringValue(body.redirect_uri);
  if (!code) throw new NotionCompatOAuthError(400, 'invalid_request', 'code is required.');
  // Hanji's public authorization URL always carries redirect_uri, matching
  // Notion's current authorization flow; the token exchange must therefore
  // repeat the exact URI instead of weakening the code binding.
  if (!redirectUri) throw new NotionCompatOAuthError(400, 'invalid_request', 'redirect_uri is required.');
  validateNotionCompatRedirectUri(registration, redirectUri);
  const db = context.admin.db('app');
  const codeRow = await findByHash<McpOAuthAuthorizationCode>(
    db,
    'mcp_oauth_authorization_codes',
    'codeHash',
    await sha256Base64Url(code),
  );
  if (
    !codeRow
    || codeRow.clientId !== registration.clientId
    || codeRow.codeChallengeMethod !== CONFIDENTIAL_CODE_METHOD
    || codeRow.codeChallenge !== registration.clientId
    || codeRow.redirectUri !== redirectUri
    || codeRow.consumedAt
    || Date.parse(codeRow.expiresAt) <= Date.now()
  ) {
    throw new NotionCompatOAuthError(400, 'invalid_grant', 'Authorization code is invalid.');
  }
  const grant = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), codeRow.grantId);
  const workspace = await activeGrantWorkspace(db, grant);
  if (!grant || !workspace || grant.clientId !== registration.clientId || grant.resource !== compatResource(context)) {
    throw new NotionCompatOAuthError(400, 'invalid_grant', 'Authorization grant is no longer active.');
  }
  const scopes = codeRow.scopes ?? grant.scopes ?? [];
  const access = await issueCompatAccessToken(context, grant, workspace.id, scopes);
  const refresh = await prepareCompatRefreshToken(grant, scopes);
  const now = nowIso();
  try {
    await db.transact([
      {
        table: 'mcp_oauth_grants',
        op: 'expect',
        where: [['id', '==', grant.id], ['status', '==', 'active']],
        exists: true,
      },
      {
        table: 'mcp_oauth_authorization_codes',
        op: 'expect',
        where: [['id', '==', codeRow.id], ['consumedAt', '==', null]],
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
        id: grant.id,
        data: { lastUsedAt: now },
      },
    ]);
  } catch {
    throw new NotionCompatOAuthError(400, 'invalid_grant', 'Authorization code is invalid.');
  }
  return tokenResponse(db, workspace, grant, access.token, refresh.token);
}

async function refreshTokenGrant(
  context: FunctionContext,
  registration: NotionCompatClientRegistration,
  body: Record<string, unknown>,
) {
  const presented = stringValue(body.refresh_token);
  if (!presented) throw new NotionCompatOAuthError(400, 'invalid_request', 'refresh_token is required.');
  const db = context.admin.db('app');
  const token = await findByHash<McpOAuthRefreshToken>(
    db,
    'mcp_oauth_refresh_tokens',
    'tokenHash',
    await sha256Base64Url(presented),
  );
  const invalid = () => new NotionCompatOAuthError(400, 'invalid_grant', 'Refresh token is invalid.');
  if (!token || token.clientId !== registration.clientId || token.resource !== compatResource(context)) throw invalid();
  const now = nowIso();
  if ((token.status ?? 'active') === 'rotated') {
    await revokeMcpGrantFamily(db, token.grantId, 'system:refresh-token-reuse', now);
    throw invalid();
  }
  if ((token.status ?? 'active') !== 'active' || token.revokedAt || refreshTokenExpired(token)) throw invalid();
  const grant = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), token.grantId);
  const workspace = await activeGrantWorkspace(db, grant);
  if (!grant || !workspace || grant.clientId !== registration.clientId || grant.resource !== compatResource(context)) throw invalid();
  const scopes = token.scopes ?? grant.scopes ?? [];
  const access = await issueCompatAccessToken(context, grant, workspace.id, scopes);
  const successor = await prepareCompatRefreshToken(grant, scopes);
  try {
    await db.transact([
      {
        table: 'mcp_oauth_grants',
        op: 'expect',
        where: [['id', '==', grant.id], ['status', '==', 'active']],
        exists: true,
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'expect',
        where: [['id', '==', token.id], ['status', '==', 'active']],
        exists: true,
      },
      {
        table: 'mcp_oauth_refresh_tokens',
        op: 'update',
        id: token.id,
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
        id: grant.id,
        data: { lastUsedAt: now },
      },
    ]);
  } catch {
    await revokeMcpGrantFamily(db, token.grantId, 'system:refresh-token-reuse', now).catch(() => undefined);
    throw invalid();
  }
  const current = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), grant.id);
  if (!grantIsActive(current)) throw invalid();
  return tokenResponse(db, workspace, grant, access.token, successor.token);
}

async function verifiedCompatClaims(
  context: Pick<FunctionContext, 'request' | 'env'>,
  token: string,
) {
  const payload = await verifySignedJwt(token, context.env, context.request) as unknown as Partial<NotionCompatAccessTokenClaims>;
  const now = Math.floor(Date.now() / 1000);
  if (
    payload.typ !== 'hanji_notion_compat_access'
    || payload.iss !== originOf(context.request, context.env)
    || payload.aud !== compatResource(context)
    || !payload.sub
    || !payload.grant_id
    || !payload.client_id
    || !payload.workspace_id
    || typeof payload.exp !== 'number'
    || payload.exp <= now
  ) {
    throw new Error('Notion-compatible access token is invalid.');
  }
  return payload as NotionCompatAccessTokenClaims;
}

/** Resolves a Notion-compatible bearer into the Hanji actor and hard workspace scope. */
export async function resolveNotionCompatBearer(
  context: FunctionContext,
  rawToken?: string,
): Promise<NotionCompatBearerIdentity | null> {
  const token = rawToken ?? context.request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return null;
  let claims: NotionCompatAccessTokenClaims;
  try {
    claims = await verifiedCompatClaims(context, token);
  } catch (error) {
    if (error instanceof Error && error.message.includes('HANJI_MCP_OAUTH_SECRET is required')) throw error;
    return null;
  }
  const db = context.admin.db('app');
  const grant = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), claims.grant_id);
  const workspace = await activeGrantWorkspace(db, grant);
  if (
    !grant
    || !workspace
    || grant.clientId !== claims.client_id
    || grant.userId !== claims.sub
    || grant.resource !== claims.aud
    || workspace.id !== claims.workspace_id
  ) return null;
  const members = await listAll(
    db.table<WorkspaceMember>('workspace_members').where('workspaceId', '==', workspace.id),
  );
  return {
    id: grant.userId,
    email: members.find((member) => member.userId === grant.userId)?.email ?? null,
    workspaceId: workspace.id,
    scopes: stringList(claims.scope),
    grant,
    claims,
  };
}

export function assertNotionCompatWorkspaceScope(identity: NotionCompatBearerIdentity, workspaceId: string) {
  if (identity.workspaceId !== workspaceId) {
    throw new NotionCompatOAuthError(403, 'restricted_resource', 'The token is not authorized for this workspace.');
  }
}

async function revokeToken(
  context: FunctionContext,
  registration: NotionCompatClientRegistration,
  body: Record<string, unknown>,
) {
  const token = stringValue(body.token);
  if (!token) throw new NotionCompatOAuthError(400, 'invalid_request', 'token is required.');
  const db = context.admin.db('app');
  const refresh = await findByHash<McpOAuthRefreshToken>(
    db,
    'mcp_oauth_refresh_tokens',
    'tokenHash',
    await sha256Base64Url(token),
  );
  if (refresh?.clientId === registration.clientId) {
    await revokeMcpGrantFamily(db, refresh.grantId, `client:${registration.clientId}`);
    return { request_id: newId() };
  }
  if (token.split('.').length === 3) {
    let claims: NotionCompatAccessTokenClaims | null = null;
    try {
      claims = await verifiedCompatClaims(context, token);
    } catch (error) {
      if (error instanceof Error && error.message.includes('HANJI_MCP_OAUTH_SECRET is required')) throw error;
    }
    if (claims?.client_id === registration.clientId) {
      const grant = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), claims.grant_id);
      if (grant?.clientId === registration.clientId) {
        await revokeMcpGrantFamily(db, grant.id, `client:${registration.clientId}`);
      }
    }
  }
  // Token revocation is deliberately non-enumerating.
  return { request_id: newId() };
}

async function introspectToken(
  context: FunctionContext,
  registration: NotionCompatClientRegistration,
  body: Record<string, unknown>,
) {
  const token = stringValue(body.token);
  if (!token) throw new NotionCompatOAuthError(400, 'invalid_request', 'token is required.');
  const inactive = () => ({ active: false, request_id: newId() });
  if (token.split('.').length !== 3) return inactive();
  let claims: NotionCompatAccessTokenClaims;
  try {
    claims = await verifiedCompatClaims(context, token);
  } catch (error) {
    if (error instanceof Error && error.message.includes('HANJI_MCP_OAUTH_SECRET is required')) throw error;
    return inactive();
  }
  if (claims.client_id !== registration.clientId) return inactive();
  const db = context.admin.db('app');
  const grant = await getExisting(db.table<McpOAuthGrant>('mcp_oauth_grants'), claims.grant_id);
  const workspace = await activeGrantWorkspace(db, grant);
  if (
    !grant
    || !workspace
    || grant.clientId !== registration.clientId
    || grant.userId !== claims.sub
    || grant.resource !== claims.aud
    || workspace.id !== claims.workspace_id
  ) return inactive();
  return {
    active: true,
    scope: claims.scope,
    iat: claims.iat,
    request_id: newId(),
  };
}

function oauthJson(data: unknown, status = 200, clientError = false) {
  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
  });
  if (clientError) headers.set('WWW-Authenticate', 'Basic realm="Hanji Notion-compatible OAuth"');
  return new Response(JSON.stringify(data), { status, headers });
}

function oauthErrorResponse(error: unknown) {
  const requestId = newId();
  if (error instanceof NotionCompatOAuthError) {
    return oauthJson({
      object: 'error',
      status: error.status,
      code: error.code,
      message: error.message,
      request_id: requestId,
    }, error.status, error.code === 'invalid_client');
  }
  console.error('[notion-compat-oauth] request failed:', error);
  return oauthJson({
    object: 'error',
    status: 500,
    code: 'internal_server_error',
    message: 'OAuth request could not be completed.',
    request_id: requestId,
  }, 500);
}

async function requestObject(request: Request) {
  const parsed = await request.json().catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new NotionCompatOAuthError(400, 'invalid_request', 'A JSON request body is required.');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Canonical implementation for POST /v1/oauth/token, /revoke, /introspect.
 * The compatibility route should delegate exact two-segment OAuth paths here.
 */
export async function handleNotionCompatOAuthRequest(
  context: FunctionContext,
  action: 'token' | 'revoke' | 'introspect',
) {
  try {
    const body = await requestObject(context.request);
    const registration = await authenticateClient(context, body);
    if (action === 'revoke') return oauthJson(await revokeToken(context, registration, body));
    if (action === 'introspect') return oauthJson(await introspectToken(context, registration, body));
    const grantType = stringValue(body.grant_type);
    if (grantType === 'authorization_code') {
      return oauthJson(await authorizationCodeGrant(context, registration, body));
    }
    if (grantType === 'refresh_token') {
      return oauthJson(await refreshTokenGrant(context, registration, body));
    }
    throw new NotionCompatOAuthError(
      400,
      'unsupported_grant_type',
      'Only authorization_code and refresh_token are supported.',
    );
  } catch (error) {
    return oauthErrorResponse(error);
  }
}
