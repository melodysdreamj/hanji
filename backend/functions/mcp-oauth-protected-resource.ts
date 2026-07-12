import { defineFunction } from '@edge-base/shared';
import {
  MCP_SUPPORTED_SCOPES,
  endpointUrls,
  json,
  optionsResponse,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request?: Request;
  env?: Record<string, unknown>;
}

export const OPTIONS = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  return optionsResponse(context.request);
});

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const urls = endpointUrls(context);
  return json({
    resource: urls.resource,
    authorization_servers: [urls.origin],
    scopes_supported: MCP_SUPPORTED_SCOPES,
    resource_documentation: `${urls.origin}/api/functions/mcp-oauth-protected-resource`,
  });
});
