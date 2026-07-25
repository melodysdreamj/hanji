import { defineFunction } from '@edge-base/shared';
import type { DbRef } from '../../../lib/app-types';
import {
  NotionAdminApiError,
  issueOrganizationAdminToken,
  listOrganizationAdminTokens,
  revokeOrganizationAdminToken,
} from '../../../lib/notion-admin-auth';

interface FunctionContext {
  auth: { id: string } | null;
  request?: Request;
  admin: { db(namespace: string): DbRef };
}

function jsonError(error: unknown) {
  const known = error instanceof NotionAdminApiError
    ? error
    : new NotionAdminApiError(500, 'internal_server_error', 'An unexpected error occurred.');
  return Response.json({ status: known.status, code: known.code, message: known.message }, { status: known.status });
}

async function bodyOf(request?: Request) {
  const body = await request?.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new NotionAdminApiError(400, 'validation_error', 'The request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

export const notionAdminTokenHandler = async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  try {
    if (!context.auth?.id) throw new NotionAdminApiError(401, 'unauthorized', 'Authentication is required.');
    const body = await bodyOf(context.request);
    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    const action = typeof body.action === 'string' ? body.action : 'list';
    const db = context.admin.db('app');
    if (action === 'list') {
      return {
        adminTokens: await listOrganizationAdminTokens(db, organizationId, context.auth.id),
      };
    }
    if (action === 'create') {
      const resources = body.resources && typeof body.resources === 'object' && !Array.isArray(body.resources)
        ? body.resources as Record<string, unknown>
        : {};
      const created = await issueOrganizationAdminToken(db, {
        organizationId,
        actorId: context.auth.id,
        label: typeof body.label === 'string' ? body.label : '',
        capabilities: body.capabilities,
        workspaceIds: resources.workspaceIds ?? body.workspaceIds,
        legalHoldIds: resources.legalHoldIds ?? body.legalHoldIds,
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      });
      return {
        adminToken: created.token,
        // This field is intentionally absent from every later list/revoke call.
        adminTokenSecret: created.tokenSecret,
      };
    }
    if (action === 'revoke') {
      return {
        adminToken: await revokeOrganizationAdminToken(db, {
          organizationId,
          actorId: context.auth.id,
          tokenId: typeof body.tokenId === 'string' ? body.tokenId : '',
        }),
      };
    }
    throw new NotionAdminApiError(400, 'validation_error', 'Unknown token action.');
  } catch (error) {
    return jsonError(error);
  }
};

export const POST = defineFunction({
  trigger: { type: 'http' as const },
  maxRequestBodyBytes: 64 * 1024,
  handler: notionAdminTokenHandler,
});
