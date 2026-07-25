import { defineFunction } from '@edge-base/shared';
import { handleScimRequest, type ScimFunctionContext } from '../../../lib/scim-handler';

export const scimHandler = (context: unknown) => handleScimRequest(context as ScimFunctionContext);

const definition = {
  trigger: { type: 'http' as const },
  customBearerAuth: true,
  maxRequestBodyBytes: 1024 * 1024,
  handler: scimHandler,
};

export const GET = defineFunction(definition);
export const POST = defineFunction(definition);
export const PUT = defineFunction(definition);
export const PATCH = defineFunction(definition);
export const DELETE = defineFunction(definition);
