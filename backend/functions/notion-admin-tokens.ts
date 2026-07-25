import { defineFunction } from '@edge-base/shared';
import { notionAdminTokenHandler } from './notion/admin/tokens';

// Signed-in organization admins use this product-facing mutation endpoint to
// provision one-time Admin API bot tokens. It is intentionally separate from
// the bearer-authenticated Notion-compatible `/admin/v1` surface.
export const POST = defineFunction({
  trigger: { type: 'http' as const },
  maxRequestBodyBytes: 64 * 1024,
  handler: notionAdminTokenHandler,
});
