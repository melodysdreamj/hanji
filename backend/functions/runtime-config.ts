import { defineFunction } from '@edge-base/shared';

interface FunctionContext {
  request?: Request;
  env?: Record<string, unknown>;
}

function envValue(env: Record<string, unknown> | undefined, name: string) {
  const contextValue = env?.[name];
  if (typeof contextValue === 'string' && contextValue.trim()) {
    return contextValue.trim();
  }
  if (typeof contextValue === 'boolean') {
    return contextValue ? 'true' : 'false';
  }
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env?.[name]?.trim() || undefined;
}

function envFlag(env: Record<string, unknown> | undefined, ...names: string[]) {
  for (const name of names) {
    const value = envValue(env, name);
    if (!value) continue;
    return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
  }
  return false;
}

function isLocalHostname(hostname: string) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function requestHostname(request?: Request) {
  if (!request?.url) return '';
  try {
    return new URL(request.url).hostname;
  } catch {
    return '';
  }
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const localOrigin = isLocalHostname(requestHostname(context.request));
  const devGuestEnabled = envFlag(
    context.env,
    'NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN',
    'NOTIONLIKE_ALLOW_ANONYMOUS_BOOTSTRAP',
  );

  return Response.json({
    ok: true,
    allowAnonymousBootstrap: localOrigin && devGuestEnabled,
  });
});
