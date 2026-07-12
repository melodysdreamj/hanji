import { defineFunction } from '@edge-base/shared';
import { notionCompatHandler } from '../notion/v1/[...slug]';

export const GET = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const POST = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const PATCH = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
export const DELETE = defineFunction({
  trigger: { type: 'http' },
  maxRequestBodyBytes: 4 * 1024 * 1024,
  handler: notionCompatHandler,
});
