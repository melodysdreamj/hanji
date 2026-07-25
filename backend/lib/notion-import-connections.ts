import { notionErrorFromResponse, notionRequest } from './notion-api-client';
import {
  NOTION_CREDENTIAL_ALGORITHM,
  NOTION_CREDENTIAL_KEY_ID,
  NOTION_OAUTH_STATE_MAX_AGE_MS,
  assertNotionOAuthEnabled,
  base64EncodeText,
  decodeNotionOAuthState,
  decryptNotionCredential,
  encodeNotionOAuthState,
  encryptNotionCredential,
  encryptNotionOAuthCredential,
  notionApiBase,
  notionConnectionStorageAvailable,
  notionOAuthAuthorizeUrl,
  notionOAuthClientId,
  notionOAuthClientSecret,
  notionOAuthRedirectUri,
  type NotionOAuthStatePayload,
} from './notion-import-credentials';
import { normalizedNotionId } from './notion-import-request-limits';
import { recordWorkspaceAudit } from './org-audit';
import type { ShareRole } from './page-access';
import {
  getExisting,
  newId,
  nowIso,
  requireString,
  type TableQuery,
  type TransactDb,
} from './table-utils';

interface NotionImportConnectionTable<T> extends TableQuery<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

export interface NotionImportConnectionDb extends TransactDb {
  table<T>(name: string): NotionImportConnectionTable<T>;
}

interface NotionImportConnectionTokenJob {
  connectionId?: string | null;
  options?: Record<string, unknown>;
}

interface NotionImportConnectionWorkspaceJob {
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  options?: Record<string, unknown>;
}

export type NotionImportConnectionKind = 'oauth' | 'personal_access_token' | 'internal_integration' | 'manual_token';

export type NotionImportConnectionStatus = 'active' | 'revoked' | 'error';

export interface NotionImportConnection {
  id: string;
  workspaceId: string;
  actorId?: string;
  name?: string;
  connectionKind: NotionImportConnectionKind;
  status: NotionImportConnectionStatus;
  apiVersion: string;
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  tokenFingerprint?: string | null;
  credentialAlgorithm?: string | null;
  credentialKeyId?: string | null;
  credentialCiphertext?: string | null;
  metadata?: Record<string, unknown>;
  lastValidatedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type SafeNotionImportConnection = Omit<NotionImportConnection, 'credentialCiphertext'> & {
  metadata: Record<string, unknown>;
  hasStoredCredential: boolean;
};

export interface NotionTokenSource {
  token: string;
  tokenStored: false;
  credentialSource: 'request' | 'connection';
  connectionId?: string;
  connection?: SafeNotionImportConnection;
  tokenFingerprint?: string | null;
}

export interface NotionImportRootCandidate {
  id: string;
  notionObject: 'page' | 'data_source';
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  reason: 'workspace_parent' | 'accessible_parent_missing';
}

export interface NotionImportRootScanItem {
  id: string;
  notionObject: 'page' | 'data_source';
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  archived?: boolean;
  inTrash?: boolean;
}

export interface NotionImportConnectionRuntime {
  NOTION_API_VERSION: string;
  NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT: number;
  NOTION_ROOT_SCAN_MAX_PAGE_LIMIT: number;
  optionalString(value: unknown): string | undefined;
  parsePositiveInt(value: unknown, fallback: number, max: number): number;
  listAll<T>(query: TableQuery<T>, maxItems?: number): Promise<T[]>;
  assertWorkspaceRole(
    db: NotionImportConnectionDb,
    workspaceId: string,
    actorId: string,
    minimum: ShareRole,
  ): Promise<void>;
  assertWritableImportTarget(
    db: NotionImportConnectionDb,
    workspaceId: string,
    parentPageId: string | undefined,
    actorId: string,
  ): Promise<void>;
  asRecord(value: unknown): Record<string, unknown> | undefined;
  notionObjectId(record: Record<string, unknown>): string | undefined;
  notionParentResourceId(record: Record<string, unknown>): string | undefined;
  notionParentType(record: Record<string, unknown>): string | undefined;
  notionTitle(record: Record<string, unknown>): string;
}

export function createNotionImportConnectionHandlers(runtime: NotionImportConnectionRuntime) {
  const {
    NOTION_API_VERSION,
    NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT,
    NOTION_ROOT_SCAN_MAX_PAGE_LIMIT,
    optionalString,
    parsePositiveInt,
    listAll,
    assertWorkspaceRole,
    assertWritableImportTarget,
    asRecord,
    notionObjectId,
    notionParentResourceId,
    notionParentType,
    notionTitle,
  } = runtime;

  const connectionKinds = new Set<NotionImportConnectionKind>([
    'oauth',
    'personal_access_token',
    'internal_integration',
    'manual_token',
  ]);

  function parseConnectionKind(value: unknown): NotionImportConnectionKind {
    if (typeof value === 'string' && connectionKinds.has(value as NotionImportConnectionKind)) {
      return value as NotionImportConnectionKind;
    }
    return 'personal_access_token';
  }

  async function beginOAuthConnection(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    assertNotionOAuthEnabled(env);
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
    const redirectUri = notionOAuthRedirectUri(env, body);
    const name = optionalString(body.name);
    const now = nowIso();
    const payload: NotionOAuthStatePayload = {
      workspaceId,
      actorId,
      redirectUri,
      name,
      nonce: newId(),
      createdAt: now,
    };
    const state = await encodeNotionOAuthState(payload, env);
    const authorizationUrl = new URL(notionOAuthAuthorizeUrl(env));
    authorizationUrl.searchParams.set('client_id', notionOAuthClientId(env));
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('owner', 'user');
    authorizationUrl.searchParams.set('state', state);
    const expiresAt = new Date(new Date(now).getTime() + NOTION_OAUTH_STATE_MAX_AGE_MS).toISOString();

    await recordWorkspaceAudit(db, {
      workspaceId,
      actorId,
      action: 'notion_import.oauth.begin',
      targetType: 'notion_import_connection',
      targetId: workspaceId,
      metadata: {
        redirectUri,
        connectionKind: 'oauth',
      },
      occurredAt: now,
    });

    return {
      authorizationUrl: authorizationUrl.toString(),
      state,
      redirectUri,
      expiresAt,
    };
  }

  async function completeOAuthConnection(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    assertNotionOAuthEnabled(env);
    const oauthError = optionalString(body.error);
    if (oauthError) throw new Error(`Notion OAuth failed: ${oauthError}`);
    const code = requireString(body.code, 'code');
    const state = requireString(body.state, 'state');
    const payload = await decodeNotionOAuthState(state, env);
    if (payload.actorId !== actorId) throw new Error('Notion OAuth state belongs to another user.');
    await assertWorkspaceRole(db, payload.workspaceId, actorId, 'edit');
    const redirectUri = notionOAuthRedirectUri(env, {
      redirectUri: optionalString(body.redirectUri) ?? payload.redirectUri,
    });
    if (redirectUri !== payload.redirectUri) throw new Error('Notion OAuth redirect URI does not match the signed state.');

    const apiVersion = optionalString(body.apiVersion) ?? NOTION_API_VERSION;
    const apiBase = notionApiBase(env);
    const tokenResponse = await notionOAuthTokenRequest({ code, redirectUri, apiVersion }, env);
    const accessToken = requireString(tokenResponse.access_token, 'access_token');
    const refreshToken = optionalString(tokenResponse.refresh_token);
    const tokenType = optionalString(tokenResponse.token_type) ?? 'bearer';
    const me = await notionRequest(accessToken, '/users/me', apiVersion, { apiBase });
    const notionWorkspace = notionOAuthWorkspaceInfo(tokenResponse, me);
    const name =
      optionalString(body.name) ??
      payload.name ??
      notionWorkspace.name ??
      optionalString(tokenResponse.workspace_name) ??
      'Notion OAuth connection';
    const now = nowIso();
    const credentialCiphertext = await encryptNotionOAuthCredential({
      accessToken,
      refreshToken,
      tokenType,
    }, env);
    const connection = await db.table<NotionImportConnection>('notion_import_connections').insert({
      id: newId(),
      workspaceId: payload.workspaceId,
      actorId,
      name,
      connectionKind: 'oauth',
      status: 'active',
      apiVersion,
      notionWorkspaceId: notionWorkspace.id,
      notionWorkspaceName: notionWorkspace.name,
      tokenFingerprint: await tokenFingerprint(accessToken),
      credentialAlgorithm: NOTION_CREDENTIAL_ALGORITHM,
      credentialKeyId: NOTION_CREDENTIAL_KEY_ID,
      credentialCiphertext,
      metadata: {
        oauth: {
          tokenType,
          botId: optionalString(tokenResponse.bot_id),
          workspaceIcon: optionalString(tokenResponse.workspace_icon),
          duplicatedTemplateId: optionalString(tokenResponse.duplicated_template_id),
          requestId: optionalString(tokenResponse.request_id),
          hasRefreshToken: !!refreshToken,
          owner: safeNotionOAuthOwner(tokenResponse.owner),
        },
        notionBot: {
          id: typeof me.id === 'string' ? me.id : undefined,
          type: typeof me.type === 'string' ? me.type : undefined,
        },
      },
      lastValidatedAt: now,
    });

    await recordWorkspaceAudit(db, {
      workspaceId: payload.workspaceId,
      actorId,
      action: 'notion_import.oauth.complete',
      targetType: 'notion_import_connection',
      targetId: connection.id,
      metadata: {
        connectionKind: 'oauth',
        notionWorkspaceId: notionWorkspace.id,
        notionWorkspaceName: notionWorkspace.name,
        hasRefreshToken: !!refreshToken,
      },
      occurredAt: now,
    });

    return { connection: cleanConnection(connection) };
  }

  async function createConnection(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    await assertWorkspaceRole(db, workspaceId, actorId, 'edit');
    const token = requireString(body.notionToken, 'notionToken');
    const connectionKind = parseConnectionKind(body.connectionKind ?? 'internal_integration');
    const name = optionalString(body.name) ?? 'Notion connection';
    const apiVersion = optionalString(body.apiVersion) ?? NOTION_API_VERSION;
    const apiBase = notionApiBase(env);
    const now = nowIso();
    const me = await notionRequest(token, '/users/me', apiVersion, { apiBase });
    const notionWorkspace = notionWorkspaceInfo(me);
    const credentialCiphertext = await encryptNotionCredential(token, env);
    const connection = await db.table<NotionImportConnection>('notion_import_connections').insert({
      id: newId(),
      workspaceId,
      actorId,
      name,
      connectionKind,
      status: 'active',
      apiVersion,
      notionWorkspaceId: notionWorkspace.id,
      notionWorkspaceName: notionWorkspace.name,
      tokenFingerprint: await tokenFingerprint(token),
      credentialAlgorithm: NOTION_CREDENTIAL_ALGORITHM,
      credentialKeyId: NOTION_CREDENTIAL_KEY_ID,
      credentialCiphertext,
      metadata: {
        notionBot: {
          id: typeof me.id === 'string' ? me.id : undefined,
          type: typeof me.type === 'string' ? me.type : undefined,
        },
      },
      lastValidatedAt: now,
    });

    await recordWorkspaceAudit(db, {
      workspaceId,
      actorId,
      action: 'notion_import.connection.create',
      targetType: 'notion_import_connection',
      targetId: connection.id,
      metadata: {
        connectionKind,
        notionWorkspaceId: notionWorkspace.id,
        notionWorkspaceName: notionWorkspace.name,
      },
      occurredAt: now,
    });

    return { connection: cleanConnection(connection) };
  }

  async function listConnections(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    await assertWorkspaceRole(db, workspaceId, actorId, 'view');
    const limit = parsePositiveInt(body.limit, 20, 100);
    const connections = await listAll(
      db.table<NotionImportConnection>('notion_import_connections').where('workspaceId', '==', workspaceId),
      500,
    );
    return {
      connectionStorageAvailable: notionConnectionStorageAvailable(env),
      connections: connections
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
        .slice(0, limit)
        .map(cleanConnection),
    };
  }

  async function getActiveConnection(db: NotionImportConnectionDb, connectionId: string, actorId: string) {
    const connection = await getExisting(db.table<NotionImportConnection>('notion_import_connections'), connectionId);
    if (!connection) throw new Error('Notion import connection was not found.');
    await assertWorkspaceRole(db, connection.workspaceId, actorId, 'edit');
    if (connection.status !== 'active') throw new Error('Notion import connection is not active.');
    return connection;
  }

  async function revokeConnection(db: NotionImportConnectionDb, body: Record<string, unknown>, actorId: string) {
    const connectionId = requireString(body.connectionId, 'connectionId');
    const connections = db.table<NotionImportConnection>('notion_import_connections');
    const connection = await getActiveConnection(db, connectionId, actorId);
    const now = nowIso();
    const updated = await connections.update(connection.id, {
      status: 'revoked',
      credentialCiphertext: null,
      revokedAt: now,
      revokedBy: actorId,
    });
    await recordWorkspaceAudit(db, {
      workspaceId: connection.workspaceId,
      actorId,
      action: 'notion_import.connection.revoke',
      targetType: 'notion_import_connection',
      targetId: connection.id,
      occurredAt: now,
    });
    return { connection: cleanConnection(updated) };
  }

  async function tokenFromStoredConnection(
    db: NotionImportConnectionDb,
    connection: NotionImportConnection,
    env: Record<string, unknown> | undefined,
  ) {
    if (connection.connectionKind === 'oauth') assertNotionOAuthEnabled(env);
    const credential = await decryptNotionCredential(connection, env);
    if (credential.kind === 'token') {
      const now = nowIso();
      const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
        lastUsedAt: now,
        error: null,
      });
      return {
        token: credential.token,
        connection: updated,
        tokenFingerprint: connection.tokenFingerprint ?? await tokenFingerprint(credential.token),
        refreshed: false,
      };
    }

    assertNotionOAuthEnabled(env);

    const refreshToken = optionalString(credential.refreshToken);
    if (!refreshToken) {
      const now = nowIso();
      const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
        lastUsedAt: now,
        error: null,
      });
      return {
        token: credential.accessToken,
        connection: updated,
        tokenFingerprint: connection.tokenFingerprint ?? await tokenFingerprint(credential.accessToken),
        refreshed: false,
      };
    }

    const apiVersion = connection.apiVersion || NOTION_API_VERSION;
    const refreshed = await notionOAuthRefreshTokenRequest({ refreshToken, apiVersion }, env);
    const accessToken = requireString(refreshed.access_token, 'access_token');
    const nextRefreshToken = optionalString(refreshed.refresh_token) ?? refreshToken;
    const tokenType = optionalString(refreshed.token_type) ?? credential.tokenType ?? 'bearer';
    const now = nowIso();
    const credentialCiphertext = await encryptNotionOAuthCredential({
      accessToken,
      refreshToken: nextRefreshToken,
      tokenType,
      refreshedAt: now,
    }, env);
    const fingerprint = await tokenFingerprint(accessToken);
    const existingMetadata = connection.metadata ?? {};
    const existingOAuthMetadata = existingMetadata.oauth && typeof existingMetadata.oauth === 'object'
      ? existingMetadata.oauth as Record<string, unknown>
      : {};
    const refreshedOwner = safeNotionOAuthOwner(refreshed.owner);
    const updated = await db.table<NotionImportConnection>('notion_import_connections').update(connection.id, {
      credentialCiphertext,
      tokenFingerprint: fingerprint,
      notionWorkspaceId: optionalString(refreshed.workspace_id) ?? connection.notionWorkspaceId,
      notionWorkspaceName: optionalString(refreshed.workspace_name) ?? connection.notionWorkspaceName,
      metadata: {
        ...existingMetadata,
        oauth: {
          ...existingOAuthMetadata,
          tokenType,
          botId: optionalString(refreshed.bot_id) ?? optionalString(existingOAuthMetadata.botId),
          workspaceIcon: optionalString(refreshed.workspace_icon) ?? optionalString(existingOAuthMetadata.workspaceIcon),
          duplicatedTemplateId: optionalString(refreshed.duplicated_template_id) ??
            optionalString(existingOAuthMetadata.duplicatedTemplateId),
          requestId: optionalString(refreshed.request_id) ?? optionalString(existingOAuthMetadata.requestId),
          hasRefreshToken: !!nextRefreshToken,
          owner: refreshedOwner ?? existingOAuthMetadata.owner,
          refreshedAt: now,
        },
      },
      lastUsedAt: now,
      lastValidatedAt: now,
      error: null,
    });
    return {
      token: accessToken,
      connection: updated,
      tokenFingerprint: fingerprint,
      refreshed: true,
    };
  }

  async function notionTokenForJob(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    job: NotionImportConnectionTokenJob,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ): Promise<NotionTokenSource> {
    const directToken = optionalString(body.notionToken);
    if (directToken) {
      return {
        token: directToken,
        tokenStored: false,
        credentialSource: 'request',
        connectionId: optionalString(body.connectionId) ?? job.connectionId ?? undefined,
        tokenFingerprint: await tokenFingerprint(directToken),
      };
    }

    const options = job.options as { connectionId?: unknown } | undefined;
    const connectionId = optionalString(body.connectionId) ?? optionalString(options?.connectionId) ?? job.connectionId ?? undefined;
    if (!connectionId) throw new Error('notionToken or connectionId is required.');
    const connection = await getActiveConnection(db, connectionId, actorId);
    const tokenSource = await tokenFromStoredConnection(db, connection, env);
    return {
      token: tokenSource.token,
      tokenStored: false,
      credentialSource: 'connection',
      connectionId: connection.id,
      connection: cleanConnection(tokenSource.connection),
      tokenFingerprint: tokenSource.tokenFingerprint,
    };
  }

  function cleanConnection(connection: NotionImportConnection): SafeNotionImportConnection {
    const safeConnection = { ...connection };
    delete safeConnection.credentialCiphertext;
    return {
      ...safeConnection,
      metadata: connection.metadata ?? {},
      hasStoredCredential: !!connection.credentialCiphertext,
    } as SafeNotionImportConnection;
  }

  function notionRootCandidateObject(record: Record<string, unknown>) {
    const object = optionalString(record.object);
    return object === 'page' || object === 'data_source' ? object : undefined;
  }

  function compactNotionRootScanItem(record: Record<string, unknown>): NotionImportRootScanItem | null {
    const notionObject = notionRootCandidateObject(record);
    const id = notionObjectId(record);
    if (!notionObject || !id) return null;
    return {
      id,
      notionObject,
      title: notionTitle(record),
      parentNotionId: notionParentResourceId(record) ?? null,
      parentType: notionParentType(record) ?? null,
      createdTime: optionalString(record.created_time) ?? null,
      lastEditedTime: optionalString(record.last_edited_time) ?? null,
      url: optionalString(record.url) ?? null,
      icon: asRecord(record.icon) ?? null,
      archived: record.archived === true || record.is_archived === true,
      inTrash: record.in_trash === true,
    };
  }

  function notionAccessibleRootCandidates(records: Record<string, unknown>[]): NotionImportRootCandidate[] {
    const knownIds = new Set(
      records
        .map((record) => normalizedNotionId(notionObjectId(record)))
        .filter(Boolean),
    );
    const byId = new Map<string, NotionImportRootCandidate>();

    for (const record of records) {
      const notionObject = notionRootCandidateObject(record);
      if (!notionObject) continue;
      if (record.archived === true || record.in_trash === true || record.is_archived === true) continue;

      const id = notionObjectId(record);
      const normalizedId = normalizedNotionId(id);
      if (!id || !normalizedId || byId.has(normalizedId)) continue;

      const parentType = notionParentType(record);
      // Database rows (a page whose parent is a database/data source) are never
      // standalone import roots — they come in with their database. Without this,
      // a partial /search page flags rows as accessible_parent_missing (their data
      // source isn't in that same page) and floods the root picker with rows.
      if (parentType === 'database_id' || parentType === 'data_source_id') continue;
      const parentNotionId = notionParentResourceId(record);
      const normalizedParentId = normalizedNotionId(parentNotionId);
      const isWorkspaceParent = parentType === 'workspace';
      const isAccessibleParentMissing = !!normalizedParentId && !knownIds.has(normalizedParentId);
      if (!isWorkspaceParent && !isAccessibleParentMissing) continue;

      byId.set(normalizedId, {
        id,
        notionObject,
        title: notionTitle(record),
        parentNotionId: parentNotionId ?? null,
        parentType: parentType ?? null,
        createdTime: optionalString(record.created_time) ?? null,
        lastEditedTime: optionalString(record.last_edited_time) ?? null,
        url: optionalString(record.url) ?? null,
        icon: asRecord(record.icon) ?? null,
        reason: isWorkspaceParent ? 'workspace_parent' : 'accessible_parent_missing',
      });
    }

    return Array.from(byId.values()).sort((a, b) => {
      const reasonScore = (root: NotionImportRootCandidate) => root.reason === 'workspace_parent' ? 0 : 1;
      const scoreDelta = reasonScore(a) - reasonScore(b);
      if (scoreDelta !== 0) return scoreDelta;
      const editedDelta = String(b.lastEditedTime ?? '').localeCompare(String(a.lastEditedTime ?? ''));
      if (editedDelta !== 0) return editedDelta;
      return a.title.localeCompare(b.title);
    });
  }

  async function notionOAuthTokenRequest(
    input: {
      code: string;
      redirectUri: string;
      apiVersion: string;
    },
    env: Record<string, unknown> | undefined,
  ) {
    const url = `${notionApiBase(env)}/oauth/token`;
    const clientId = notionOAuthClientId(env);
    const clientSecret = notionOAuthClientSecret(env);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${base64EncodeText(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/json',
        'Notion-Version': input.apiVersion,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
    if (!response.ok) throw await notionErrorFromResponse(response);
    const data = await response.json().catch(() => ({}));
    if (!data || typeof data !== 'object') throw new Error('Notion OAuth token response was invalid.');
    const record = data as Record<string, unknown>;
    if (!optionalString(record.access_token)) throw new Error('Notion OAuth token response did not include an access token.');
    return record;
  }

  async function notionOAuthRefreshTokenRequest(
    input: {
      refreshToken: string;
      apiVersion: string;
    },
    env: Record<string, unknown> | undefined,
  ) {
    const url = `${notionApiBase(env)}/oauth/token`;
    const clientId = notionOAuthClientId(env);
    const clientSecret = notionOAuthClientSecret(env);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${base64EncodeText(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/json',
        'Notion-Version': input.apiVersion,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: input.refreshToken,
      }),
    });
    if (!response.ok) throw await notionErrorFromResponse(response);
    const data = await response.json().catch(() => ({}));
    if (!data || typeof data !== 'object') throw new Error('Notion OAuth refresh response was invalid.');
    const record = data as Record<string, unknown>;
    if (!optionalString(record.access_token)) throw new Error('Notion OAuth refresh response did not include an access token.');
    return record;
  }

  async function tokenFingerprint(token: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return Array.from(new Uint8Array(digest))
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  function notionWorkspaceInfo(me: Record<string, unknown>) {
    const bot = me.bot;
    const botRecord = bot && typeof bot === 'object' ? (bot as Record<string, unknown>) : {};
    return {
      id: typeof botRecord.workspace_id === 'string' ? botRecord.workspace_id : undefined,
      name: typeof botRecord.workspace_name === 'string' ? botRecord.workspace_name : undefined,
    };
  }

  function cachedNotionWorkspaceForDiscovery(
    job: NotionImportConnectionWorkspaceJob,
    tokenSource: {
      connection?: Pick<NotionImportConnection, 'notionWorkspaceId' | 'notionWorkspaceName'>;
      tokenFingerprint?: string | null;
    },
  ) {
    const connectionWorkspace = {
      id: optionalString(tokenSource.connection?.notionWorkspaceId),
      name: optionalString(tokenSource.connection?.notionWorkspaceName),
    };
    if (connectionWorkspace.id || connectionWorkspace.name) return connectionWorkspace;

    // A request-only import may resume with a different token. Reuse the job's
    // display-only workspace metadata only when it was observed under the exact
    // same token fingerprint; every page/data-source request still performs its
    // normal Notion authorization check.
    const previousFingerprint = optionalString(
      (job.options as { tokenFingerprint?: unknown } | undefined)?.tokenFingerprint,
    );
    const currentFingerprint = optionalString(tokenSource.tokenFingerprint);
    if (!previousFingerprint || previousFingerprint !== currentFingerprint) return undefined;

    const jobWorkspace = {
      id: optionalString(job.notionWorkspaceId),
      name: optionalString(job.notionWorkspaceName),
    };
    return jobWorkspace.id || jobWorkspace.name ? jobWorkspace : undefined;
  }

  function notionOAuthWorkspaceInfo(tokenResponse: Record<string, unknown>, me: Record<string, unknown>) {
    const fromMe = notionWorkspaceInfo(me);
    return {
      id: fromMe.id ?? optionalString(tokenResponse.workspace_id),
      name: fromMe.name ?? optionalString(tokenResponse.workspace_name),
    };
  }

  function safeNotionOAuthOwner(owner: unknown) {
    if (!owner || typeof owner !== 'object') return undefined;
    const ownerRecord = owner as Record<string, unknown>;
    const user = ownerRecord.user && typeof ownerRecord.user === 'object'
      ? ownerRecord.user as Record<string, unknown>
      : undefined;
    return {
      type: optionalString(ownerRecord.type),
      user: user
        ? {
            id: optionalString(user.id),
            object: optionalString(user.object),
            type: optionalString(user.type),
            name: optionalString(user.name),
            avatarUrl: optionalString(user.avatar_url),
          }
        : undefined,
    };
  }

  async function scanAccessibleNotionRoots(
    token: string,
    options: {
      apiVersion: string;
      maxSearchPages: number;
      apiBase?: string;
      startCursor?: string;
      includeWorkspace?: boolean;
    },
  ) {
    const notionWorkspace = options.includeWorkspace === false
      ? undefined
      : notionWorkspaceInfo(await notionRequest(token, '/users/me', options.apiVersion, { apiBase: options.apiBase }));
    const records: Record<string, unknown>[] = [];
    let cursor: string | undefined = options.startCursor;
    let hasMore = false;
    let nextCursor: string | undefined;
    let searchPagesFetched = 0;
    let incompleteReason: string | undefined;

    for (let page = 0; page < options.maxSearchPages; page += 1) {
      const response = await notionRequest(token, '/search', options.apiVersion, {
        method: 'POST',
        body: {
          page_size: 100,
          sort: {
            direction: 'descending',
            timestamp: 'last_edited_time',
          },
          ...(cursor ? { start_cursor: cursor } : {}),
        },
        apiBase: options.apiBase,
      });
      searchPagesFetched += 1;
      const results = Array.isArray(response.results)
        ? response.results.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        : [];
      records.push(...results);
      const requestStatus = asRecord(response.request_status);
      incompleteReason = optionalString(requestStatus?.incomplete_reason) ?? incompleteReason;
      hasMore = response.has_more === true;
      nextCursor = optionalString(response.next_cursor);
      cursor = nextCursor;
      if (!hasMore || !cursor) break;
    }

    return {
      roots: notionAccessibleRootCandidates(records),
      items: records.map(compactNotionRootScanItem).filter((item): item is NotionImportRootScanItem => !!item),
      scanned: records.length,
      searchPagesFetched,
      hasMore,
      nextCursor: nextCursor ?? null,
      incompleteReason: incompleteReason ?? null,
      notionWorkspace,
    };
  }

  async function listAccessibleRoots(
    db: NotionImportConnectionDb,
    body: Record<string, unknown>,
    actorId: string,
    env: Record<string, unknown> | undefined,
  ) {
    const workspaceId = requireString(body.workspaceId, 'workspaceId');
    const parentPageId = optionalString(body.parentPageId);
    await assertWritableImportTarget(db, workspaceId, parentPageId, actorId);

    const connectionId = optionalString(body.connectionId);
    const tokenSource = await notionTokenForJob(db, body, { connectionId, options: { connectionId } }, actorId, env);
    if (tokenSource.connection?.workspaceId && tokenSource.connection.workspaceId !== workspaceId) {
      throw new Error('Notion import connection belongs to another workspace.');
    }

    const scan = await scanAccessibleNotionRoots(tokenSource.token, {
      apiVersion: optionalString(body.apiVersion) ?? NOTION_API_VERSION,
      maxSearchPages: parsePositiveInt(
        body.maxSearchPages,
        NOTION_ROOT_SCAN_DEFAULT_PAGE_LIMIT,
        NOTION_ROOT_SCAN_MAX_PAGE_LIMIT,
      ),
      apiBase: notionApiBase(env),
      startCursor: optionalString(body.startCursor),
      includeWorkspace: body.includeWorkspace !== false,
    });

    if (body.recordAudit !== false) {
      await recordWorkspaceAudit(db, {
        workspaceId,
        actorId,
        action: 'notion_import.root_scan',
        targetType: 'workspace',
        targetId: workspaceId,
        metadata: {
          connectionId: tokenSource.connectionId,
          credentialSource: tokenSource.credentialSource,
          tokenFingerprint: tokenSource.tokenFingerprint,
          scanned: scan.scanned,
          roots: scan.roots.length,
          searchPagesFetched: scan.searchPagesFetched,
          hasMore: scan.hasMore,
          incompleteReason: scan.incompleteReason,
          incremental: !!optionalString(body.startCursor),
        },
        occurredAt: nowIso(),
      });
    }

    return scan;
  }

  return {
    beginOAuthConnection,
    completeOAuthConnection,
    createConnection,
    listConnections,
    revokeConnection,
    listAccessibleRoots,
    parseConnectionKind,
    notionTokenForJob,
    notionWorkspaceInfo,
    cachedNotionWorkspaceForDiscovery,
    notionAccessibleRootCandidates,
  };
}
