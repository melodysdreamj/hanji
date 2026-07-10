import { defineFunction } from '@edge-base/shared';
import { notionCompatHandler } from '../notion/v1/[...slug]';

export const GET = defineFunction(notionCompatHandler);
export const POST = defineFunction(notionCompatHandler);
export const PATCH = defineFunction(notionCompatHandler);
export const DELETE = defineFunction(notionCompatHandler);
