import { defineFunction } from '@edge-base/shared';
import { notionAdminHandler } from '../../notion/admin/v1/[...slug]';

// Compatibility alias for clients configured with a base URL ending in
// `/api/functions/admin`, matching Notion's `https://api.notion.com/admin`
// convention. The canonical Hanji route remains `/notion/admin/v1/...`.
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
