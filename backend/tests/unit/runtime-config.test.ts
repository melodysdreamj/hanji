import { describe, expect, it } from 'vitest';

import {
  configuredPublicHttpsUrl,
  GET,
  publicLegalUrls,
  publicNotionOAuthConfigured,
  publicOAuthProviders,
} from '../../functions/runtime-config';
import { handlerOf } from './helpers/function-context';

const UPSTREAM = 'https://github.com/melodysdreamj/hanji';

describe('public runtime configuration', () => {
  it('enables guest bootstrap only for the current server flag on a loopback request', async () => {
    const currentResponse = await handlerOf(GET)({
      env: { HANJI_ALLOW_DEV_GUEST_LOGIN: 'true' },
      request: new Request('http://127.0.0.1/api/functions/runtime-config'),
    }) as Response;
    const retiredAliasResponse = await handlerOf(GET)({
      env: { HANJI_ALLOW_ANONYMOUS_BOOTSTRAP: 'true' },
      request: new Request('http://127.0.0.1/api/functions/runtime-config'),
    }) as Response;
    const publicResponse = await handlerOf(GET)({
      env: { HANJI_ALLOW_DEV_GUEST_LOGIN: 'true' },
      request: new Request('https://app.example.com/api/functions/runtime-config'),
    }) as Response;

    await expect(currentResponse.json()).resolves.toMatchObject({ allowAnonymousBootstrap: true });
    await expect(retiredAliasResponse.json()).resolves.toMatchObject({ allowAnonymousBootstrap: false });
    await expect(publicResponse.json()).resolves.toMatchObject({ allowAnonymousBootstrap: false });
  });

  it('uses revision-pinned upstream legal links when a build SHA is available', async () => {
    const revision = '0123456789abcdef0123456789abcdef01234567';
    const response = await handlerOf(GET)({
      env: { HANJI_BUILD_SHA: revision },
      request: new Request('https://app.example.com/api/functions/runtime-config'),
    }) as Response;

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      allowAnonymousBootstrap: false,
      oauthProviders: [],
      notionOAuthConfigured: false,
      legal: {
        sourceUrl: `${UPSTREAM}/tree/${revision}`,
        agplLicenseUrl: `${UPSTREAM}/blob/${revision}/LICENSE`,
        sponsorExceptionUrl: `${UPSTREAM}/blob/${revision}/LICENSE-EXCEPTION`,
      },
    });
  });

  it('exposes only social providers that the backend can actually complete', () => {
    expect(publicOAuthProviders({
      HANJI_AUTH_OAUTH_PROVIDERS: 'google, github, google, x, Invalid Provider',
      HANJI_OAUTH_GOOGLE_CLIENT_ID: 'google-client',
      HANJI_OAUTH_GOOGLE_CLIENT_SECRET: 'google-secret',
      HANJI_OAUTH_GITHUB_CLIENT_ID: 'github-client',
      HANJI_OAUTH_X_CLIENT_ID: 'x-client',
      HANJI_OAUTH_X_CLIENT_SECRET: 'x-secret',
    })).toEqual(['google', 'x']);
  });

  it('lets exact off clear stale social-provider configuration', () => {
    expect(publicOAuthProviders({
      HANJI_AUTH_OAUTH_PROVIDERS: 'off',
      EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS: 'google',
      HANJI_OAUTH_GOOGLE_CLIENT_ID: 'stale-client',
      HANJI_OAUTH_GOOGLE_CLIENT_SECRET: 'stale-secret',
    })).toEqual([]);
  });

  it('advertises Notion OAuth only when the complete stored-connection flow is configured', () => {
    const complete = {
      HANJI_NOTION_OAUTH_ENABLED: 'true',
      HANJI_NOTION_OAUTH_CLIENT_ID: 'notion-client',
      HANJI_NOTION_OAUTH_CLIENT_SECRET: 'notion-secret',
      HANJI_NOTION_OAUTH_REDIRECT_URI: 'https://app.example.com/?notion_import_oauth=1',
      HANJI_NOTION_OAUTH_STATE_SECRET: 'state-secret',
      HANJI_NOTION_IMPORT_SECRET: 'connection-secret',
      HANJI_APP_ORIGIN: 'https://app.example.com',
    };
    expect(publicNotionOAuthConfigured(complete)).toBe(true);
    expect(publicNotionOAuthConfigured({
      ...complete,
      HANJI_NOTION_OAUTH_STATE_SECRET: '',
    })).toBe(false);
    expect(publicNotionOAuthConfigured({
      ...complete,
      HANJI_NOTION_OAUTH_REDIRECT_URI: 'https://other.example.com/?notion_import_oauth=1',
    })).toBe(false);
    for (const enabled of [undefined, 'false', 'TRUE', '1']) {
      expect(publicNotionOAuthConfigured({
        ...complete,
        HANJI_NOTION_OAUTH_ENABLED: enabled,
      })).toBe(false);
    }
  });

  it('returns capability metadata without exposing OAuth credentials', async () => {
    const response = await handlerOf(GET)({
      request: new Request('https://app.example.com/api/functions/runtime-config'),
      env: {
        HANJI_APP_ORIGIN: 'https://app.example.com',
        HANJI_AUTH_OAUTH_PROVIDERS: 'x',
        HANJI_OAUTH_X_CLIENT_ID: 'client-id-sentinel',
        HANJI_OAUTH_X_CLIENT_SECRET: 'social-secret-sentinel',
        HANJI_NOTION_OAUTH_ENABLED: 'true',
        HANJI_NOTION_OAUTH_CLIENT_ID: 'notion-client-sentinel',
        HANJI_NOTION_OAUTH_CLIENT_SECRET: 'notion-secret-sentinel',
        HANJI_NOTION_OAUTH_REDIRECT_URI: 'https://app.example.com/?notion_import_oauth=1',
        HANJI_NOTION_OAUTH_STATE_SECRET: 'state-secret-sentinel',
        HANJI_NOTION_IMPORT_SECRET: 'storage-secret-sentinel',
      },
    }) as Response;
    const body = await response.text();

    expect(JSON.parse(body)).toMatchObject({
      oauthProviders: ['x'],
      notionOAuthConfigured: true,
    });
    for (const secret of [
      'client-id-sentinel',
      'social-secret-sentinel',
      'notion-client-sentinel',
      'notion-secret-sentinel',
      'state-secret-sentinel',
      'storage-secret-sentinel',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('accepts deployment-specific public HTTPS links and removes fragments', () => {
    expect(publicLegalUrls({
      HANJI_SOURCE_URL: 'https://source.example/releases/v1#readme',
      HANJI_AGPL_LICENSE_URL: 'https://source.example/releases/v1/LICENSE',
      HANJI_SPONSOR_EXCEPTION_URL: 'https://source.example/releases/v1/LICENSE-EXCEPTION',
    })).toEqual({
      sourceUrl: 'https://source.example/releases/v1',
      agplLicenseUrl: 'https://source.example/releases/v1/LICENSE',
      sponsorExceptionUrl: 'https://source.example/releases/v1/LICENSE-EXCEPTION',
    });
  });

  it('falls back instead of exposing unsafe, private, credentialed, or non-HTTPS values', () => {
    const fallback = `${UPSTREAM}/blob/main/LICENSE`;
    for (const value of [
      'javascript:alert(1)',
      'http://example.com/LICENSE',
      'https://127.0.0.1/LICENSE',
      'https://[fd00::1]/LICENSE',
      'https://user:password@example.com/LICENSE',
    ]) {
      expect(configuredPublicHttpsUrl(value, fallback)).toBe(fallback);
    }
  });
});
