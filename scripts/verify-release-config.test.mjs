import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
  parseEnvFile,
  releaseModeEnabled,
  secureBrowserSessionConfigured,
  validateProductionEnvironment,
} from './verify-release-config.mjs';

const requireFromBackend = createRequire(resolve('backend/package.json'));
const typescript = requireFromBackend('typescript');

test('release mode must be a literal top-level true value', () => {
  assert.equal(releaseModeEnabled('export default defineConfig({ release: true })', typescript), true);
  assert.equal(releaseModeEnabled('export default defineConfig({ release: false })', typescript), false);
  assert.equal(releaseModeEnabled('const release = true; export default defineConfig({ release })', typescript), false);
});

test('browser refresh sessions require a named Strict cookie and exact credential origins', () => {
  const valid = `export default defineConfig({
    auth: { session: { cookie: { enabled: true, name: 'app-refresh', sameSite: 'strict' } } },
    cors: { origin: ['http://localhost:3000', 'https://app.example.com', APP_ORIGIN], credentials: true },
  })`;
  assert.equal(secureBrowserSessionConfigured(valid, typescript), true);
  assert.equal(
    secureBrowserSessionConfigured(valid.replace("sameSite: 'strict'", "sameSite: 'none'"), typescript),
    false,
  );
  assert.equal(
    secureBrowserSessionConfigured(valid.replace("'https://app.example.com'", "'https://*.example.com'"), typescript),
    false,
  );
  assert.equal(
    secureBrowserSessionConfigured(valid.replace('credentials: true', 'credentials: false'), typescript),
    false,
  );
  assert.equal(
    secureBrowserSessionConfigured(valid.replace('APP_ORIGIN', 'ARBITRARY_ORIGIN'), typescript),
    false,
  );
});

test('environment parser handles comments, export syntax, and quoted values', () => {
  assert.deepEqual(parseEnvFile('# comment\nexport A=one\nB="two words"\n'), {
    A: 'one',
    B: 'two words',
  });
});

test('production validation accepts a complete explicit configuration', () => {
  const result = validateProductionEnvironment({
    JWT_USER_SECRET: 'u'.repeat(32),
    JWT_ADMIN_SECRET: 'a'.repeat(32),
    NOTIONLIKE_NOTION_IMPORT_SECRET: 'i'.repeat(32),
    NOTIONLIKE_MCP_OAUTH_SECRET: 'm'.repeat(32),
    NOTIONLIKE_APP_ORIGIN: 'https://app.example.com',
    NOTIONLIKE_PASSKEY_RP_ID: 'example.com',
    NOTIONLIKE_PASSKEY_ORIGINS: 'https://app.example.com',
    NOTIONLIKE_AUTH_EMAIL_FROM: 'no-reply@example.com',
    NOTIONLIKE_CLOUDFLARE_EMAIL_BINDING: 'EMAIL',
    NOTIONLIKE_INSTANCE_ADMIN_EMAILS: 'admin@example.com',
    NOTIONLIKE_BUILD_SHA: 'abc123',
  });

  assert.deepEqual(result.errors, []);
});

test('production validation rejects placeholder secrets and implicit admin bootstrap', () => {
  const result = validateProductionEnvironment({
    JWT_USER_SECRET: 'change-me',
    JWT_ADMIN_SECRET: '',
    NOTIONLIKE_APP_ORIGIN: 'http://localhost:8787',
  });

  assert.ok(result.errors.some((error) => error.includes('JWT_USER_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('instance-admin')));
  assert.ok(result.errors.some((error) => error.includes('public HTTPS origin')));
});
