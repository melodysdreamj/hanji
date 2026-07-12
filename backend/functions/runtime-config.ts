import { defineFunction } from '@edge-base/shared';
import {
  hanjiCanonicalEnvValue,
  hanjiEnvFlag,
  hanjiEnvListWithOffSentinel,
  hanjiEnvValue,
} from '../lib/hanji-compat';
import { normalizePublicUrl } from '../lib/ssrf-guard';

const UPSTREAM_REPOSITORY_URL = 'https://github.com/melodysdreamj/hanji';
const UPSTREAM_LICENSE_URL = `${UPSTREAM_REPOSITORY_URL}/blob/main/LICENSE`;
const UPSTREAM_SPONSOR_EXCEPTION_URL = `${UPSTREAM_REPOSITORY_URL}/blob/main/LICENSE-EXCEPTION`;

interface FunctionContext {
  request?: Request;
  env?: Record<string, unknown>;
}

const OAUTH_PROVIDER_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function oauthEnvName(provider: string, field: 'CLIENT_ID' | 'CLIENT_SECRET') {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + `_${field}`;
}

/**
 * Return only providers the backend can actually start. The browser must not
 * render a button from a separately built Vite flag that the deployed auth
 * server cannot complete.
 */
export function publicOAuthProviders(env: Record<string, unknown> | undefined) {
  const providers = hanjiEnvListWithOffSentinel(
    env,
    'HANJI_AUTH_OAUTH_PROVIDERS',
    'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS',
  );
  return Array.from(new Set(providers))
    .filter((provider) => OAUTH_PROVIDER_NAME_RE.test(provider))
    .filter((provider) => {
      const idKey = oauthEnvName(provider, 'CLIENT_ID');
      const secretKey = oauthEnvName(provider, 'CLIENT_SECRET');
      const clientId = hanjiEnvValue(
        env,
        `HANJI_OAUTH_${idKey}`,
        `EDGEBASE_OAUTH_${idKey}`,
        idKey,
      );
      const clientSecret = hanjiEnvValue(
        env,
        `HANJI_OAUTH_${secretKey}`,
        `EDGEBASE_OAUTH_${secretKey}`,
        secretKey,
      );
      return Boolean(clientId && clientSecret);
    });
}

/** Public capability bit only; no credential or redirect value is exposed. */
export function publicNotionOAuthConfigured(env: Record<string, unknown> | undefined) {
  if (hanjiCanonicalEnvValue(env, 'HANJI_NOTION_OAUTH_ENABLED') !== 'true') return false;
  const complete = [
    'HANJI_NOTION_OAUTH_CLIENT_ID',
    'HANJI_NOTION_OAUTH_CLIENT_SECRET',
    'HANJI_NOTION_OAUTH_REDIRECT_URI',
    'HANJI_NOTION_OAUTH_STATE_SECRET',
    'HANJI_NOTION_IMPORT_SECRET',
    'HANJI_APP_ORIGIN',
  ].every((name) => Boolean(hanjiEnvValue(env, name)));
  if (!complete) return false;
  try {
    const appOrigin = new URL(hanjiEnvValue(env, 'HANJI_APP_ORIGIN')!).origin;
    const configuredRedirect = new URL(
      hanjiEnvValue(env, 'HANJI_NOTION_OAUTH_REDIRECT_URI')!,
    ).toString();
    return configuredRedirect === `${appOrigin}/?notion_import_oauth=1`;
  } catch {
    return false;
  }
}

function exactBuildRevision(env: Record<string, unknown> | undefined) {
  const value = hanjiEnvValue(env, 'HANJI_BUILD_SHA');
  return value && /^[0-9a-f]{7,64}$/i.test(value) ? value : '';
}

function upstreamLegalUrls(env: Record<string, unknown> | undefined) {
  const revision = exactBuildRevision(env);
  if (!revision) {
    return {
      sourceUrl: UPSTREAM_REPOSITORY_URL,
      agplLicenseUrl: UPSTREAM_LICENSE_URL,
      sponsorExceptionUrl: UPSTREAM_SPONSOR_EXCEPTION_URL,
    };
  }
  return {
    sourceUrl: `${UPSTREAM_REPOSITORY_URL}/tree/${revision}`,
    agplLicenseUrl: `${UPSTREAM_REPOSITORY_URL}/blob/${revision}/LICENSE`,
    sponsorExceptionUrl: `${UPSTREAM_REPOSITORY_URL}/blob/${revision}/LICENSE-EXCEPTION`,
  };
}

export function configuredPublicHttpsUrl(value: unknown, fallback: string) {
  const normalized = normalizePublicUrl(value);
  if (!normalized) return fallback;
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'https:' || url.username || url.password) return fallback;
    return url.toString();
  } catch {
    return fallback;
  }
}

export function publicLegalUrls(env: Record<string, unknown> | undefined) {
  const defaults = upstreamLegalUrls(env);
  return {
    sourceUrl: configuredPublicHttpsUrl(
      hanjiEnvValue(env, 'HANJI_SOURCE_URL'),
      defaults.sourceUrl,
    ),
    agplLicenseUrl: configuredPublicHttpsUrl(
      hanjiEnvValue(env, 'HANJI_AGPL_LICENSE_URL'),
      defaults.agplLicenseUrl,
    ),
    sponsorExceptionUrl: configuredPublicHttpsUrl(
      hanjiEnvValue(env, 'HANJI_SPONSOR_EXCEPTION_URL'),
      defaults.sponsorExceptionUrl,
    ),
  };
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
  const devGuestEnabled = hanjiEnvFlag(
    context.env,
    'HANJI_ALLOW_DEV_GUEST_LOGIN',
  );

  return Response.json(
    {
      ok: true,
      allowAnonymousBootstrap: localOrigin && devGuestEnabled,
      oauthProviders: publicOAuthProviders(context.env),
      notionOAuthConfigured: publicNotionOAuthConfigured(context.env),
      legal: publicLegalUrls(context.env),
    },
    // This response also carries a request-origin-sensitive dev bootstrap bit;
    // never let an intermediary reuse it for another hostname.
    { headers: { 'Cache-Control': 'no-store' } },
  );
});
