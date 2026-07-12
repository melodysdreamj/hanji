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
    issuer: urls.origin,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    revocation_endpoint: urls.revoke,
    registration_endpoint: urls.registration,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: MCP_SUPPORTED_SCOPES,
    resource_indicators_supported: true,
  });
});
