import { defineFunction } from '@edge-base/shared';
import { POST as importExportPOST } from '../../../import-export';
import { POST as workspaceMutationPOST } from '../../../workspace-mutation';
import {
  handleNotionAdminRequest,
  notionAdminArtifactFromMarkdown,
  type NotionAdminCanonicalOperations,
  type NotionAdminFunctionContext,
} from '../../../../lib/notion-admin-api';

type FunctionHandler = (context: unknown) => Promise<unknown> | unknown;

function handlerOf(definition: unknown): FunctionHandler {
  if (typeof definition === 'function') return definition as FunctionHandler;
  const handler = (definition as { handler?: FunctionHandler } | null)?.handler;
  if (typeof handler !== 'function') throw new Error('The canonical function handler is unavailable.');
  return handler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function callCanonical(
  definition: unknown,
  context: NotionAdminFunctionContext,
  actor: { id: string; email?: string },
  body: Record<string, unknown>,
) {
  if (!context.request) throw new Error('Request context is missing.');
  const headers = new Headers(context.request.headers);
  headers.set('content-type', 'application/json');
  // Never forward the organization-bot bearer to a product mutation. The
  // canonical handler receives a freshly serialized request plus the managed
  // user/security-admin identity selected by the Admin API adapter.
  headers.delete('authorization');
  const request = new Request(context.request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const result = await handlerOf(definition)({ ...context, auth: actor, request });
  if (!(result instanceof Response)) return result;
  const payload = await result.json().catch(() => ({})) as Record<string, unknown>;
  if (!result.ok) {
    throw new Error(typeof payload.message === 'string' ? payload.message : 'The canonical operation failed.');
  }
  return payload;
}

function canonicalOperations(context: NotionAdminFunctionContext): NotionAdminCanonicalOperations {
  return {
    async executeWorkspaceExport(input) {
      if (input.request.export_type === 'pdf') {
        throw new Error('A canonical PDF renderer is not configured for workspace exports.');
      }
      if (input.request.include_comments === true) {
        throw new Error('The canonical markdown exporter does not include comments.');
      }
      if (input.request.include_contents === 'no_files') {
        throw new Error('The canonical markdown exporter cannot currently exclude file references.');
      }
      if (
        input.request.collection_view_export_type === 'currentView'
        || (Array.isArray(input.request.teamspace_ids) && input.request.teamspace_ids.length > 0)
      ) {
        throw new Error('The requested scoped workspace export is not available in the canonical exporter.');
      }
      const canonical = await callCanonical(importExportPOST, context, {
        id: input.actorId,
        email: input.actorEmail,
      }, {
        action: 'exportWorkspaceMarkdown',
        workspaceId: input.workspaceId,
      });
      if (!isRecord(canonical) || typeof canonical.markdown !== 'string') {
        throw new Error('The canonical markdown exporter returned no artifact.');
      }
      if (input.request.export_type === 'html') {
        return {
          artifact: notionAdminArtifactFromMarkdown(canonical.markdown, 'html'),
          pageCount: canonical.pageCount,
        };
      }
      return {
        artifact: notionAdminArtifactFromMarkdown(canonical.markdown, 'markdown'),
        pageCount: canonical.pageCount,
      };
    },
    async executeLegalHoldExport(input) {
      return callCanonical(workspaceMutationPOST, context, { id: input.actorId }, {
        action: 'exportOrganizationDiscovery',
        organizationId: input.organizationId,
        workspaceIds: [input.workspaceId],
        userIds: input.userIds,
        includeTrashed: true,
        format: 'jsonl',
      });
    },
  };
}

export const notionAdminHandler = (rawContext: unknown) => {
  const context = rawContext as NotionAdminFunctionContext;
  return handleNotionAdminRequest(context, canonicalOperations(context));
};

const definition = {
  trigger: { type: 'http' as const },
  customBearerAuth: true,
  maxRequestBodyBytes: 1024 * 1024,
  handler: notionAdminHandler,
};

export const GET = defineFunction(definition);
export const POST = defineFunction(definition);
export const PATCH = defineFunction(definition);
export const DELETE = defineFunction(definition);
