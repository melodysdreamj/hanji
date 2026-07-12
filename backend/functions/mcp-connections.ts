import { defineFunction } from '@edge-base/shared';
import {
  MCP_DEFAULT_SCOPES,
  type DbRef,
  type McpOAuthGrant,
  accessibleWorkspaces,
  endpointUrls,
  grantIsActive,
  issueAccessToken,
  issueRefreshToken,
  json,
  jsonError,
  listAll,
  nowIso,
  publicGrant,
  readOnlyFromScopes,
  requestBody,
  revokeMcpGrantFamily,
  stringValue,
  validateMcpScopes,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  auth: { id: string; email?: string | null } | null;
  admin: {
    db(namespace: string): DbRef;
  };
}

function requireAuth(context: FunctionContext) {
  if (!context.auth?.id) throw new Error('Authentication required.');
  return context.auth.id;
}

async function listConnections(context: FunctionContext) {
  const actorId = requireAuth(context);
  const db = context.admin.db('app');
  const grants = await listAll(
    db.table<McpOAuthGrant>('mcp_oauth_grants').where('userId', '==', actorId),
  );
  const workspaces = await accessibleWorkspaces(db, actorId);
  const accessibleWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const urls = endpointUrls(context);
  const grantViews = [];
  for (const grant of grants.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))) {
    const selectedWorkspaceIds = (grant.workspaceIds ?? [])
      .map(String)
      .filter((workspaceId) => accessibleWorkspaceIds.has(workspaceId));
    const hasWorkspaceAccess = (grant.workspaceAccess ?? 'all_accessible') === 'selected'
      ? selectedWorkspaceIds.length > 0
      : workspaces.length > 0;
    let visibleGrant = grant;
    if (grantIsActive(grant) && !hasWorkspaceAccess) {
      const now = nowIso();
      await revokeMcpGrantFamily(db, grant.id, 'system:workspace-access-lost', now).catch((error) => {
        console.error('[mcp-connections] failed to revoke inaccessible grant:', error);
      });
      visibleGrant = {
        ...grant,
        status: 'revoked',
        revokedAt: now,
        revokedBy: 'system:workspace-access-lost',
      };
    }
    grantViews.push({
      ...publicGrant(visibleGrant),
      workspaceIds: selectedWorkspaceIds,
    });
  }
  return {
    ok: true,
    mcpServerUrl: urls.resource,
    authorizationServerMetadataUrl: urls.authorizationServer,
    protectedResourceMetadataUrl: urls.protectedResource,
    defaultScopes: MCP_DEFAULT_SCOPES,
    accessibleWorkspaceCount: workspaces.length,
    grants: grantViews,
  };
}

async function revokeConnection(context: FunctionContext, body: Record<string, unknown>) {
  const actorId = requireAuth(context);
  const db = context.admin.db('app');
  const grantId = stringValue(body.grantId ?? body.id);
  if (!grantId) throw new Error('grantId is required.');
  const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').getOne(grantId);
  if (!grant || grant.userId !== actorId) throw new Error('MCP connection was not found.');
  await db.table<McpOAuthGrant>('mcp_oauth_grants').update(grant.id, {
    status: 'revoked',
    revokedAt: nowIso(),
    revokedBy: actorId,
  });
  return await listConnections(context);
}

async function createManualToken(context: FunctionContext, body: Record<string, unknown>) {
  const actorId = requireAuth(context);
  const db = context.admin.db('app');
  const urls = endpointUrls(context);
  if ((await accessibleWorkspaces(db, actorId)).length === 0) {
    throw new Error('No active workspace is available for MCP access.');
  }
  const scopes = validateMcpScopes(body.scopes, MCP_DEFAULT_SCOPES);
  const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').insert({
    userId: actorId,
    clientId: 'manual-token',
    clientName: stringValue(body.clientName, 'Manual MCP token'),
    resource: urls.resource,
    scopes,
    workspaceAccess: 'all_accessible',
    workspaceIds: [],
    pageIds: [],
    databaseIds: [],
    readOnly: readOnlyFromScopes(scopes),
    status: 'active',
    lastUsedAt: nowIso(),
  });
  const access = await issueAccessToken(context.env, context.request, grant, scopes);
  const refresh = await issueRefreshToken(db, grant, scopes);
  return {
    ...(await listConnections(context)),
    createdToken: {
      grant: publicGrant(grant),
      accessToken: access.accessToken,
      expiresIn: access.expiresIn,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
    },
  };
}

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (!context.auth?.id) return jsonError(401, 'authentication_required', 'Authentication required.');
  const body = await requestBody(context.request);
  const action = stringValue(body.action, 'list');
  try {
    if (action === 'list') return json(await listConnections(context));
    if (action === 'revoke') return json(await revokeConnection(context, body));
    if (action === 'createManualToken') return json(await createManualToken(context, body));
    return jsonError(400, 'invalid_action', 'Unsupported MCP connections action.');
  } catch (error) {
    return jsonError(400, 'request_failed', error instanceof Error ? error.message : String(error));
  }
});
