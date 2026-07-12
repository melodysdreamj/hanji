import { afterEach, describe, expect, it } from 'vitest';
import {
  HANJI_CURRENT_PAGE_FILTER_KIND,
  HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER,
  HANJI_NATIVE_FILE_EXTENSION,
  HANJI_NATIVE_FORMAT,
  HANJI_URI_PROTOCOL,
  hanjiCanonicalEnvValue,
  hanjiEnvListWithOffSentinel,
  hanjiEnvValue,
  hanjiHeader,
  hasHanjiImportedRowContextFilterMarker,
  isHanjiCurrentPageFilterValue,
  isHanjiNativeFileName,
  isHanjiNativeFormat,
  isHanjiUriProtocol,
  normalizeLegacyHanjiNativeDocument,
} from '../../lib/hanji-compat';

const legacyEnvName = (suffix: string) => `${['NOTION', 'LIKE_'].join('')}${suffix}`;
const legacyHeaderName = (suffix: string) => `X-${['Notion', 'like-'].join('')}${suffix}`;
const legacyUriProtocol = `${['notion', 'like'].join('')}:`;
const legacyNativeFormat = ['ink', 'line.export'].join('');
const legacyNativeExtension = ['.ink', 'line.json'].join('');
const legacyCurrentPageKind = `${['notion', 'like'].join('')}.current_page`;
const legacyRowMarker = `${['notion', 'like'].join('')}ImportedRowContextFilter`;
const PROCESS_TEST_ENV = 'HANJI_COMPAT_TEST_SECRET';
const LEGACY_PROCESS_TEST_ENV = legacyEnvName('COMPAT_TEST_SECRET');
const savedProcessTestEnv = process.env[PROCESS_TEST_ENV];
const savedLegacyProcessTestEnv = process.env[LEGACY_PROCESS_TEST_ENV];

afterEach(() => {
  if (savedProcessTestEnv === undefined) delete process.env[PROCESS_TEST_ENV];
  else process.env[PROCESS_TEST_ENV] = savedProcessTestEnv;
  if (savedLegacyProcessTestEnv === undefined) delete process.env[LEGACY_PROCESS_TEST_ENV];
  else process.env[LEGACY_PROCESS_TEST_ENV] = savedLegacyProcessTestEnv;
});

describe('Hanji namespace compatibility', () => {
  it('prefers canonical environment values and reads the former prefix as fallback', () => {
    expect(hanjiEnvValue({
      HANJI_APP_ORIGIN: 'https://hanji.example',
      [legacyEnvName('APP_ORIGIN')]: 'https://legacy.example',
    }, 'HANJI_APP_ORIGIN')).toBe('https://hanji.example');
    expect(hanjiEnvValue({
      [legacyEnvName('APP_ORIGIN')]: 'https://legacy.example',
    }, 'HANJI_APP_ORIGIN')).toBe('https://legacy.example');
  });

  it('treats an explicitly empty canonical context value as authoritative', () => {
    expect(hanjiEnvValue({
      HANJI_ALLOW_DEV_GUEST_LOGIN: '',
      [legacyEnvName('ALLOW_DEV_GUEST_LOGIN')]: 'true',
    }, 'HANJI_ALLOW_DEV_GUEST_LOGIN')).toBeUndefined();
    expect(hanjiEnvValue({
      HANJI_CLOUDFLARE_EMAIL_API_TOKEN: '',
      EDGEBASE_EMAIL_API_KEY: 'stale-platform-secret',
    }, 'HANJI_CLOUDFLARE_EMAIL_API_TOKEN', 'EDGEBASE_EMAIL_API_KEY')).toBeUndefined();
  });

  it('treats an explicitly empty canonical process value as authoritative', () => {
    process.env[PROCESS_TEST_ENV] = '';
    process.env[LEGACY_PROCESS_TEST_ENV] = 'stale-secret';
    expect(hanjiEnvValue(undefined, PROCESS_TEST_ENV)).toBeUndefined();
  });

  it('reads an exact canonical key without accepting the former prefix', () => {
    expect(hanjiCanonicalEnvValue({
      [legacyEnvName('NOTION_OAUTH_ENABLED')]: 'true',
    }, 'HANJI_NOTION_OAUTH_ENABLED')).toBeUndefined();
    expect(hanjiCanonicalEnvValue({
      HANJI_NOTION_OAUTH_ENABLED: 'true',
      [legacyEnvName('NOTION_OAUTH_ENABLED')]: 'false',
    }, 'HANJI_NOTION_OAUTH_ENABLED')).toBe('true');
  });

  it('uses only exact lowercase off as the stale-list clearing sentinel', () => {
    expect(hanjiEnvListWithOffSentinel({
      HANJI_AUTH_OAUTH_PROVIDERS: 'off',
      [legacyEnvName('AUTH_OAUTH_PROVIDERS')]: 'google',
      EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS: 'github',
    }, 'HANJI_AUTH_OAUTH_PROVIDERS', 'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS')).toEqual([]);
    expect(hanjiEnvListWithOffSentinel({
      HANJI_AUTH_OAUTH_PROVIDERS: 'OFF',
    }, 'HANJI_AUTH_OAUTH_PROVIDERS')).toEqual(['OFF']);
  });

  it('prefers canonical MCP headers and reads the former prefix as fallback', () => {
    const canonical = new Headers({
      'X-Hanji-MCP-Client-ID': 'hanji-client',
      [legacyHeaderName('MCP-Client-ID')]: 'legacy-client',
    });
    expect(hanjiHeader(canonical, 'X-Hanji-MCP-Client-ID')).toBe('hanji-client');
    expect(hanjiHeader(
      new Headers({ [legacyHeaderName('MCP-Client-ID')]: 'legacy-client' }),
      'X-Hanji-MCP-Client-ID',
    )).toBe('legacy-client');
  });

  it('accepts legacy links, native files, and persisted filter markers on read', () => {
    expect(isHanjiUriProtocol(HANJI_URI_PROTOCOL)).toBe(true);
    expect(isHanjiUriProtocol(legacyUriProtocol)).toBe(true);
    expect(isHanjiNativeFormat(HANJI_NATIVE_FORMAT)).toBe(true);
    expect(isHanjiNativeFormat(legacyNativeFormat)).toBe(true);
    expect(isHanjiNativeFileName(`workspace${HANJI_NATIVE_FILE_EXTENSION}`)).toBe(true);
    expect(isHanjiNativeFileName(`workspace${legacyNativeExtension}`)).toBe(true);
    expect(isHanjiCurrentPageFilterValue({ kind: HANJI_CURRENT_PAGE_FILTER_KIND })).toBe(true);
    expect(isHanjiCurrentPageFilterValue({ kind: legacyCurrentPageKind })).toBe(true);
    expect(hasHanjiImportedRowContextFilterMarker({
      [HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER]: true,
    })).toBe(true);
    expect(hasHanjiImportedRowContextFilterMarker({ [legacyRowMarker]: true })).toBe(true);
  });

  it('canonicalizes retired identifiers only in native semantic slots', () => {
    const normalized = normalizeLegacyHanjiNativeDocument({
      format: legacyNativeFormat,
      nested: [{
        link: `${legacyUriProtocol}//page/page-1`,
        filter: { kind: legacyCurrentPageKind },
        format: legacyNativeFormat,
        text: `${legacyUriProtocol}//page/plain-text`,
        [legacyRowMarker]: true,
      }],
    });

    expect(normalized).toEqual({
      format: HANJI_NATIVE_FORMAT,
      nested: [{
        link: `${HANJI_URI_PROTOCOL}//page/page-1`,
        filter: { kind: HANJI_CURRENT_PAGE_FILTER_KIND },
        format: legacyNativeFormat,
        text: `${legacyUriProtocol}//page/plain-text`,
        [HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER]: true,
      }],
    });
  });

  it('keeps the canonical row-context marker authoritative during normalization', () => {
    expect(normalizeLegacyHanjiNativeDocument({
      [legacyRowMarker]: true,
      [HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER]: false,
    })).toEqual({ [HANJI_IMPORTED_ROW_CONTEXT_FILTER_MARKER]: false });
  });

  it('reuses a canonical native tree without cloning user content', () => {
    const canonical = {
      format: HANJI_NATIVE_FORMAT,
      content: { code: `const value = '${legacyUriProtocol}//page/plain-text';` },
    };
    expect(normalizeLegacyHanjiNativeDocument(canonical)).toBe(canonical);
  });
});
