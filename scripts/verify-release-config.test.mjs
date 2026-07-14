import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  LEGAL_URL_NAMES,
  hostedEmailBindingConfigured,
  parsePreflightArgs,
  parseEnvFile,
  releaseModeEnabled,
  runPreflight,
  runtimeProcessEnvCompatibilityConfigured,
  secureBrowserSessionConfigured,
  strictGitCheckoutErrors,
  strictReleaseEnvFileErrors,
  validateProductionEnvironment,
  verifyLegalUrlsReachable,
  verifyProductionOriginsResolve,
  viteProductionEnvironmentErrors,
} from './verify-release-config.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromBackend = createRequire(resolve(repoRoot, 'backend/package.json'));
const typescript = requireFromBackend('typescript');
const currentGitHead = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
  cwd: repoRoot,
  encoding: 'utf8',
}).stdout.trim();

function testSecret(label) {
  return `${label}_7mQ2vN9xL4cR8pT6yK3dF5hJ1sW0zB`; // synthetic, high-diversity, 32+ chars
}

test('self-host bootstrap fails closed on low disk or incomplete product readiness', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/selfhost-docker.sh'), 'utf8');

  assert.match(source, /df -Pk \/data/);
  assert.match(source, /api\/functions\/health/);
  assert.match(source, /bootstrap_code=.*instance-bootstrap/);
  assert.match(source, /"masterConfigured".*true/);
  assert.match(source, /"masterReady".*true/);
  assert.match(source, /"setupBlocked".*false/);
  assert.match(source, /curl -sk --connect-timeout 1 --max-time 2/);
  assert.match(source, /curl -sk --connect-timeout 2 --max-time 10/);
  assert.match(source, /CERT_VOLUME="hanji-certs"/);
  assert.match(source, /chmod 700 "\$STATE_DIR"/);
  assert.match(source, /chmod 600 "\$ENV_FILE"/);
  assert.match(source, /chmod 600 "\$CERT_DIR\/key\.pem"/);
  assert.match(source, /chown 10001:10001 \/target\/cert\.pem \/target\/key\.pem/);
  assert.match(source, /chmod 600 \/target\/key\.pem/);
  assert.match(source, /127\.0\.0\.1:\$PORT:\$PORT/);
  assert.match(source, /HANJI_TRUST_SELF_HOSTED_PROXY=true/);
  assert.match(source, /--http requires --origin https:\/\/your-hanji-host/);
  assert.doesNotMatch(source, /chmod 644 "\$CERT_DIR\/key\.pem"/);
  assert.doesNotMatch(source, /wait_health\s*\|\|\s*true/);
  assert.match(source, /docker rm -f "\$CONTAINER".*The data volume was kept/s);
  assert.match(source, /password=\$\{MASTER_PASSWORD:-"Hanji-\$\(rand_hex 16\)"\}/);
  assert.doesNotMatch(source, /password=\$\{MASTER_PASSWORD:-"Hanji-\$\(rand_hex 5\)"\}/);
});

test('self-host launcher rejects unsafe options before contacting Docker', () => {
  const cases = [
    {
      args: ['up', '--port', 'not-a-port'],
      env: {},
      message: '--port must be an integer',
    },
    {
      args: ['up', '--email', 'attacker@example.com\nJWT_USER_SECRET=injected'],
      env: {},
      message: '--email must not contain control characters',
    },
    {
      args: ['up', '--password', 'short'],
      env: {},
      message: '--password must be at least 16 characters',
    },
    {
      args: ['up'],
      env: { HANJI_DOCKER_MIN_FREE_KB: 'invalid' },
      message: 'HANJI_DOCKER_MIN_FREE_KB must be a non-negative integer',
    },
    {
      args: ['up', '--http'],
      env: {},
      message: '--http requires --origin',
    },
    {
      args: ['up', '--http', '--origin', 'http://hanji.example.com'],
      env: {},
      message: '--origin must be an https:// URL',
    },
    {
      args: ['up', '--origin', 'https://hanji.example.com'],
      env: {},
      message: '--origin is only used together with --http',
    },
  ];

  for (const entry of cases) {
    const result = spawnSync('sh', ['scripts/selfhost-docker.sh', ...entry.args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...entry.env },
    });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(entry.message));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Starting container/);
  }
});

test('i18n release guard rejects catalogs that only copy the English source', () => {
  const source = readFileSync(resolve(repoRoot, 'scripts/i18n-status.mjs'), 'utf8');

  assert.match(source, /untranslatedCopy/);
  assert.match(source, /UNTRANSLATED_COPY/);
  assert.match(source, /catalogTopologyProblems/);
  assert.match(source, /REQUIRED_COMPLETE_LANGUAGES/);
  assert.match(source, /catalog directory has no runtime wrapper/);
  assert.match(source, /released language is absent from the selector/);
  assert.match(source, /interpolationMismatch/);
  assert.match(source, /shapeMismatch/);
  assert.match(source, /a\.orphan\.length/);
  assert.match(source, /INTENTIONAL_INTERPOLATION_VARIANTS/);
  assert.match(source, /INTERPOLATION/);
  assert.match(source, /required en\/ko coverage is current/);
});

test('browser smokes use EdgeBase origin-namespaced auth storage', () => {
  const scriptsDir = resolve(repoRoot, 'scripts');
  for (const name of readdirSync(scriptsDir).filter((entry) => entry.endsWith('.mjs'))) {
    const source = readFileSync(resolve(scriptsDir, name), 'utf8');
    assert.doesNotMatch(
      source,
      /localStorage\.setItem\(["']edgebase:refresh-token["']/,
      `${name} writes the retired cross-origin global refresh-token key`,
    );
    if (source.includes('setItem(refreshTokenKey, refreshToken)')) {
      assert.match(source, /browserAuthStorageKeys/,
        `${name} must derive its refresh-token key from the EdgeBase auth origin`);
    }
  }
});

test('multi-context visual smokes hand rotated browser sessions forward', () => {
  for (const name of [
    'basic-blocks-visual-smoke.mjs',
    'database-property-visual-smoke.mjs',
    'mentions-visual-smoke.mjs',
    'slash-menu-visual-smoke.mjs',
  ]) {
    const source = readFileSync(resolve(repoRoot, 'scripts', name), 'utf8');
    assert.match(source, /installBrowserSession\(context, seed,/,
      `${name} must seed the first context through the shared browser-session harness`);
    assert.match(source, /captureBrowserSession\(context, seed,/,
      `${name} must capture the rotated HttpOnly cookie before opening another context`);
    assert.match(source, /userId:\s*session\.userId/,
      `${name} must retain the non-secret user marker used with the captured cookie`);
    assert.doesNotMatch(source, /finally\s*\{\s*await context\.close\(/,
      `${name} must not close a seeded context before handing its rotated session forward`);
  }
});

function completeProductionEnvironment(overrides = {}) {
  return {
    JWT_USER_SECRET: testSecret('user'),
    JWT_ADMIN_SECRET: testSecret('admin'),
    JWT_USER_SECRET_OLD: '',
    JWT_USER_SECRET_OLD_AT: '',
    JWT_ADMIN_SECRET_OLD: '',
    JWT_ADMIN_SECRET_OLD_AT: '',
    HANJI_NOTION_IMPORT_SECRET: testSecret('notion'),
    HANJI_MCP_OAUTH_SECRET: testSecret('mcp'),
    HANJI_APP_ORIGIN: 'https://app.hanji.dev',
    HANJI_PASSKEY_RP_ID: '',
    HANJI_PASSKEY_ORIGINS: '',
    HANJI_AUTH_EMAIL_FROM: 'no-reply@hanji.dev',
    HANJI_CLOUDFLARE_EMAIL_BINDING: 'EMAIL',
    HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID: '1234567890abcdef1234567890abcdef',
    HANJI_CLOUDFLARE_EMAIL_API_TOKEN: testSecret('cloudflare-email-token'),
    HANJI_BROWSER_SETUP: 'true',
    HANJI_BROWSER_SETUP_TOKEN: testSecret('browser-setup-capability'),
    HANJI_TRUST_SELF_HOSTED_PROXY: 'false',
    HANJI_MASTER_EMAIL: 'master@hanji.dev',
    HANJI_MASTER_PASSWORD: 'MasterPass!2026X',
    HANJI_INSTANCE_ADMIN_USER_IDS: 'off',
    HANJI_BUILD_SHA: currentGitHead,
    HANJI_NOTION_API_BASE: 'https://api.notion.com/v1',
    HANJI_NOTION_OAUTH_AUTH_URL: 'https://api.notion.com/v1/oauth/authorize',
    HANJI_NOTION_OAUTH_CLIENT_ID: '',
    HANJI_NOTION_OAUTH_CLIENT_SECRET: '',
    HANJI_NOTION_OAUTH_REDIRECT_URI: '',
    HANJI_NOTION_OAUTH_STATE_SECRET: '',
    HANJI_NOTION_OAUTH_ENABLED: 'false',
    HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS: '14',
    HANJI_AUTH_OAUTH_PROVIDERS: 'off',
    HANJI_SSRF_DOH_URL: 'https://cloudflare-dns.com/dns-query',
    HANJI_SSRF_DNS_CHECK: 'on',
    HANJI_RATE_LIMIT_PROFILE: 'production',
    HANJI_ALLOW_DEV_GUEST_LOGIN: 'false',
    HANJI_MASTER_DEV_AUTOLOGIN: 'false',
    HANJI_SPONSORS_FEED_URL: 'https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors',
    HANJI_DEBUG_ROOM_ACCESS: '0',
    HANJI_MCP_TRUST_PROXY_HEADERS: 'false',
    ...overrides,
  };
}

function explicitLegalUrls(buildSha = currentGitHead) {
  return {
    HANJI_SOURCE_URL: `https://legal.hanji.dev/revision/${buildSha}`,
    HANJI_AGPL_LICENSE_URL: `https://legal.hanji.dev/revision/${buildSha}/LICENSE`,
    HANJI_SPONSOR_EXCEPTION_URL:
      `https://legal.hanji.dev/revision/${buildSha}/LICENSE-EXCEPTION`,
  };
}

async function resolvePublicTestAddress() {
  return [{ address: '93.184.216.34', family: 4 }];
}

function legalArtifactBody(input) {
  const path = new URL(input).pathname;
  if (path.endsWith('/LICENSE-EXCEPTION')) {
    return 'Hanji Sponsor Banner Exception\nAdditional permission under AGPL-3.0.';
  }
  if (path.endsWith('/LICENSE')) {
    return 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007';
  }
  return 'Hanji exact corresponding source artifact';
}

function writeStrictReleaseEnv(directory, env, { mode = 0o600 } = {}) {
  const envFile = join(directory, '.env.release');
  writeFileSync(
    envFile,
    `${Object.entries(env).map(([name, entry]) => `${name}=${entry}`).join('\n')}\n`,
    { mode },
  );
  chmodSync(envFile, mode);
  return envFile;
}

test('release mode must be a literal top-level true value', () => {
  assert.equal(releaseModeEnabled('export default defineConfig({ release: true })', typescript), true);
  assert.equal(releaseModeEnabled('export default defineConfig({ release: false })', typescript), false);
  assert.equal(releaseModeEnabled('const release = true; export default defineConfig({ release })', typescript), false);
});

test('release frontend CSP does not authorize plaintext loopback connections', () => {
  const source = readFileSync(resolve(repoRoot, 'backend', 'edgebase.config.ts'), 'utf8');
  const connectDirective = source.match(/"connect-src\s+([^"]+)"/)?.[1] ?? '';
  assert.equal(connectDirective, "'self' https: wss:");
  assert.doesNotMatch(connectDirective, /(?:localhost|127\.0\.0\.1|\[?::1\]?|http:)/i);
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

test('release env template declares safe hosted values and neutralizes disabled passkey state', () => {
  const source = readFileSync(resolve(repoRoot, 'backend', '.env.release.example'), 'utf8');
  for (const assignment of [
    'HANJI_ALLOW_DEV_GUEST_LOGIN=false',
    'HANJI_MASTER_DEV_AUTOLOGIN=false',
    'HANJI_RATE_LIMIT_PROFILE=production',
    'HANJI_INSTANCE_ADMIN_USER_IDS=off',
    'HANJI_AUTH_OAUTH_PROVIDERS=off',
    'HANJI_NOTION_API_BASE=https://api.notion.com/v1',
    'HANJI_NOTION_OAUTH_AUTH_URL=https://api.notion.com/v1/oauth/authorize',
    'HANJI_NOTION_OAUTH_ENABLED=false',
    'HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS=14',
    'HANJI_SSRF_DNS_CHECK=on',
    'HANJI_SSRF_DOH_URL=https://cloudflare-dns.com/dns-query',
    'HANJI_DEBUG_ROOM_ACCESS=0',
    'HANJI_MCP_TRUST_PROXY_HEADERS=false',
    'HANJI_SPONSORS_FEED_URL=https://hanji-sponsors-service.melodydreamj.workers.dev/sponsors',
  ]) {
    assert.ok(source.split(/\r?\n/).includes(assignment), `${assignment} must be explicit`);
  }
  for (const emptyDeclaration of [
    'JWT_USER_SECRET_OLD=',
    'JWT_USER_SECRET_OLD_AT=',
    'JWT_ADMIN_SECRET_OLD=',
    'JWT_ADMIN_SECRET_OLD_AT=',
    'HANJI_NOTION_OAUTH_CLIENT_ID=',
    'HANJI_NOTION_OAUTH_CLIENT_SECRET=',
    'HANJI_NOTION_OAUTH_REDIRECT_URI=',
    'HANJI_NOTION_OAUTH_STATE_SECRET=',
    'HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID=',
    'HANJI_CLOUDFLARE_EMAIL_API_TOKEN=',
    'HANJI_PASSKEY_RP_ID=',
    'HANJI_PASSKEY_ORIGINS=',
  ]) {
    assert.ok(source.split(/\r?\n/).includes(emptyDeclaration), `${emptyDeclaration} must clear stale state`);
  }
  assert.doesNotMatch(source, /HANJI_MCP_(?:PUBLIC_ORIGIN|RESOURCE|SCOPES)/);
});

test('production browser client is same-origin and anonymous bootstrap still needs explicit local runtime gates', () => {
  const clientSource = readFileSync(resolve(repoRoot, 'web/src/lib/edgebase.ts'), 'utf8');
  const authSource = readFileSync(resolve(repoRoot, 'web/src/components/AuthGate.tsx'), 'utf8');

  assert.doesNotMatch(clientSource, /VITE_EDGEBASE_URL/);
  assert.match(clientSource, /const EDGEBASE_URL = runtimeOrigin/);
  assert.match(
    clientSource,
    /const ALLOW_ANONYMOUS_BOOTSTRAP\s*=\s*import\.meta\.env\.VITE_ALLOW_ANONYMOUS_BOOTSTRAP\s*===\s*["']true["']/,
  );
  assert.match(
    authSource,
    /import\.meta\.env\.VITE_ALLOW_ANONYMOUS_BOOTSTRAP\s*===\s*["']true["']\s*&&\s*isLocalDevelopmentOrigin\(\)/,
  );
  assert.match(clientSource, /!ALLOW_ANONYMOUS_BOOTSTRAP\s*\|\|\s*!isLocalDevelopmentOrigin\(\)/);
});

test('strict release rejects browser-exposed variables from production-loaded Vite env files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hanji-vite-release-env-'));
  try {
    writeFileSync(join(directory, '.env.development.local'), 'VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true\n');
    assert.deepEqual(viteProductionEnvironmentErrors(directory), []);

    writeFileSync(join(directory, '.env.local'), 'VITE_EDGEBASE_URL=https://foreign.example\n');
    assert.ok(viteProductionEnvironmentErrors(directory).some((error) =>
      error.includes('VITE_EDGEBASE_URL') && error.includes('.env.local')));

    rmSync(join(directory, '.env.local'));
    symlinkSync(join(directory, '.env.development.local'), join(directory, '.env.production'));
    assert.ok(viteProductionEnvironmentErrors(directory).some((error) =>
      error.includes('regular file') && error.includes('.env.production')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('production validation accepts a complete explicit configuration', () => {
  const result = validateProductionEnvironment(completeProductionEnvironment());

  assert.deepEqual(result.errors, []);
});

test('production validation rejects runtime, test, debug, and proxy-trust overrides fail-closed', () => {
  for (const name of [
    'EDGEBASE_CONFIG',
    'EDGEBASE_TEST',
    'EDGEBASE_TEST_BUILD',
    'EDGEBASE_LOCAL_DEV_BUILD',
    'EDGEBASE_USE_TEST_CONFIG',
    'EDGEBASE_DEV_SIDECAR_PORT',
    'EDGEBASE_INTERNAL_WORKER_URL',
    'EDGEBASE_SMS_API_URL',
    'EDGEBASE_CONFIG_ENV_ALLOWLIST',
    'EDGEBASE_RUNTIME_MODE',
    'EDGEBASE_USE_RAW_WRANGLER_DEV',
    'EDGEBASE_EMAIL_API_URL',
    'EDGEBASE_APP_WEB_VERIFY_EMAIL_URL',
    'EDGEBASE_APP_WEB_RESET_PASSWORD_URL',
    'EDGEBASE_APP_WEB_MAGIC_LINK_URL',
    'EDGEBASE_APP_WEB_CHANGE_EMAIL_URL',
    'EDGEBASE_APP_ORIGIN',
    'EDGEBASE_PASSKEY_RP_ID',
    'EDGEBASE_PASSKEY_ORIGINS',
    'EDGEBASE_EMAIL_FROM',
    'EDGEBASE_EMAIL_PROVIDER',
    'EDGEBASE_EMAIL_CLOUDFLARE_API_TOKEN',
    'EDGEBASE_EMAIL_API_KEY',
    'EDGEBASE_EMAIL_CLOUDFLARE_ACCOUNT_ID',
    'EDGEBASE_EMAIL_CLOUDFLARE_BINDING',
    'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS',
    'EDGEBASE_MASTER_EMAIL',
    'EDGEBASE_MASTER_PASSWORD',
    'EDGEBASE_INSTANCE_ADMIN_USER_IDS',
    'EDGEBASE_INSTANCE_ADMIN_EMAILS',
    'EDGEBASE_STRICT_INSTANCE_ADMINS',
    'EDGEBASE_JWT_SECRET',
    'HANJI_MCP_JWT_SECRET',
    'HANJI_MCP_OAUTH_ALLOW_DEV_SECRET',
    'HANJI_MCP_PUBLIC_ORIGIN',
    'EDGEBASE_OAUTH_GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'VITEST',
    'VITEST_POOL_ID',
    'VITE_EDGEBASE_URL',
    'VITE_ALLOW_ANONYMOUS_BOOTSTRAP',
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment({ [name]: '' }));
    assert.ok(result.errors.some((error) => error.includes(name)), `${name} must be rejected by presence`);
  }
  for (const name of [
    'HANJI_ALLOW_DEV_GUEST_LOGIN',
    'HANJI_ALLOW_ANONYMOUS_BOOTSTRAP',
    'HANJI_MASTER_DEV_AUTOLOGIN',
    'HANJI_TRUST_SELF_HOSTED_PROXY',
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment({ [name]: 'on' }));
    assert.ok(result.errors.some((error) => error.includes(name)), `${name}=on must be rejected`);
  }
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_DEBUG_ROOM_ACCESS: 'true',
  })).errors.some((error) => error.includes('HANJI_DEBUG_ROOM_ACCESS')));
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_MCP_TRUST_PROXY_HEADERS: 'yes',
  })).errors.some((error) => error.includes('HANJI_MCP_TRUST_PROXY_HEADERS')));
});

test('production origin and optional passkey scope reject reserved, private, or ambiguous values', () => {
  for (const appOrigin of [
    'http://app.hanji.dev',
    'https://app.hanji.dev/',
    'https://app.hanji.dev/path',
    'https://app.hanji.dev?query=1',
    'https://user:password@app.hanji.dev',
    'https://app.example.com',
    'https://service.internal',
    'https://intranet',
    'https://127.0.0.1',
    'https://10.0.0.1',
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_APP_ORIGIN: appOrigin,
    }));
    assert.ok(result.errors.some((error) => error.includes('HANJI_APP_ORIGIN')), appOrigin);
  }

  const optional = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_PASSKEY_RP_ID: '',
    HANJI_PASSKEY_ORIGINS: '',
  }));
  assert.ok(!optional.errors.some((error) => error.includes('PASSKEY')));

  const valid = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_PASSKEY_RP_ID: 'hanji.dev',
    HANJI_PASSKEY_ORIGINS: 'https://app.hanji.dev',
  }));
  assert.ok(!valid.errors.some((error) => error.includes('PASSKEY')));

  for (const overrides of [
    { HANJI_PASSKEY_RP_ID: 'hanji.dev', HANJI_PASSKEY_ORIGINS: '' },
    { HANJI_PASSKEY_RP_ID: 'dev', HANJI_PASSKEY_ORIGINS: 'https://app.hanji.dev' },
    { HANJI_PASSKEY_RP_ID: 'other.dev', HANJI_PASSKEY_ORIGINS: 'https://app.hanji.dev' },
    { HANJI_PASSKEY_RP_ID: 'hanji.dev', HANJI_PASSKEY_ORIGINS: 'https://app.hanji.dev/' },
    { HANJI_PASSKEY_RP_ID: 'hanji.dev', HANJI_PASSKEY_ORIGINS: 'https://10.0.0.1' },
    { HANJI_PASSKEY_RP_ID: 'hanji.dev', HANJI_PASSKEY_ORIGINS: 'https://user:pw@app.hanji.dev' },
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment(overrides));
    assert.ok(result.errors.some((error) => error.includes('PASSKEY')), JSON.stringify(overrides));
  }
});

test('production mail configuration requires public identities and proven delivery credentials', () => {
  for (const [name, email] of [
    ['HANJI_AUTH_EMAIL_FROM', 'no-reply@example.com'],
    ['HANJI_AUTH_EMAIL_FROM', 'no-reply@service.test'],
    ['HANJI_MASTER_EMAIL', 'master@localhost'],
    ['HANJI_MASTER_EMAIL', 'master@EXAMPLE.org'],
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment({ [name]: email }));
    assert.ok(result.errors.some((error) => error.includes(name)));
  }

  const bindingOnly = completeProductionEnvironment({
    HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID: '',
    HANJI_CLOUDFLARE_EMAIL_API_TOKEN: '',
  });
  assert.ok(validateProductionEnvironment(bindingOnly).errors.some((error) => error.includes('binding')));
  assert.deepEqual(
    validateProductionEnvironment(bindingOnly, { hostedEmailBindingProven: true }).errors,
    [],
  );
  assert.ok(validateProductionEnvironment(bindingOnly, {
    hostedEmailBindingProven: true,
    // A renamed binding is not the statically proven [[send_email]] name.
  }).errors.length === 0);
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_CLOUDFLARE_EMAIL_BINDING: 'RENAMED_EMAIL',
    HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID: '',
    HANJI_CLOUDFLARE_EMAIL_API_TOKEN: '',
  }), { hostedEmailBindingProven: true }).errors.some((error) => error.includes('EMAIL')));
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID: 'not-an-account-id',
  })).errors.some((error) => error.includes('32-character hexadecimal')));
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_CLOUDFLARE_EMAIL_API_TOKEN: 'weak-token',
  })).errors.some((error) => error.includes('strong non-placeholder token')));
});

test('hosted email proof recognizes only the exact generated send_email binding', () => {
  const wrangler = readFileSync(resolve(repoRoot, 'backend', 'wrangler.toml'), 'utf8');
  assert.equal(hostedEmailBindingConfigured(wrangler), true);
  assert.equal(hostedEmailBindingConfigured(wrangler, 'RENAMED_EMAIL'), false);
  assert.equal(hostedEmailBindingConfigured('[[send_email]]\nname = "RENAMED_EMAIL"\n'), false);
  assert.equal(hostedEmailBindingConfigured('[[send_email]]\nname = "EMAIL"\n'), true);
});

test('hosted Wrangler config populates process.env for config-time release secrets', () => {
  const wrangler = readFileSync(resolve(repoRoot, 'backend', 'wrangler.toml'), 'utf8');
  assert.equal(runtimeProcessEnvCompatibilityConfigured(wrangler), true);
  assert.equal(
    runtimeProcessEnvCompatibilityConfigured(
      wrangler.replace(/,?\s*"nodejs_compat_populate_process_env"/, ''),
    ),
    false,
  );
  assert.equal(
    runtimeProcessEnvCompatibilityConfigured(wrangler.replace(/"nodejs_compat",?\s*/, '')),
    false,
  );
});

test('cryptographic and master secrets must be strong and independent', () => {
  const repeated = validateProductionEnvironment(completeProductionEnvironment({
    JWT_USER_SECRET: 'abcdefgh'.repeat(4),
  }));
  assert.ok(repeated.errors.some((error) => error.includes('JWT_USER_SECRET')));

  const duplicate = validateProductionEnvironment(completeProductionEnvironment({
    JWT_ADMIN_SECRET: testSecret('user'),
  }));
  assert.ok(duplicate.errors.some((error) => error.includes('must not equal JWT_USER_SECRET')));

  for (const password of [
    'alllowercase123!',
    'ALLUPPERCASE123!',
    'NoNumberHere!',
    'NoSpecial123',
    'Ab1! short',
    'Aa1!aaaaaa',
    'MasterPass!2026',
    'A'.repeat(257),
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_MASTER_PASSWORD: password,
    }));
    assert.ok(result.errors.some((error) => error.includes('HANJI_MASTER_PASSWORD')), password);
  }
  const passwordReuse = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_MASTER_PASSWORD: testSecret('user'),
  }));
  assert.ok(passwordReuse.errors.some((error) => error.includes('must not equal JWT_USER_SECRET')));
});

test('production validation pins enabled Notion OAuth to a safe public HTTPS redirect', () => {
  const notionOauth = {
    HANJI_NOTION_OAUTH_ENABLED: 'true',
    HANJI_NOTION_OAUTH_CLIENT_ID: 'notion-client-id',
    HANJI_NOTION_OAUTH_CLIENT_SECRET: testSecret('notion-oauth-client'),
    HANJI_NOTION_OAUTH_STATE_SECRET: testSecret('notion-oauth-state'),
  };
  const valid = validateProductionEnvironment(completeProductionEnvironment({
    ...notionOauth,
    HANJI_NOTION_OAUTH_REDIRECT_URI: 'https://app.hanji.dev/?notion_import_oauth=1',
  }));
  assert.ok(!valid.errors.some((error) => error.includes('HANJI_NOTION_OAUTH_REDIRECT_URI')));

  for (const redirectUri of [
    'http://app.hanji.dev/notion/callback',
    'https://localhost/notion/callback',
    'https://user:password@app.hanji.dev/notion/callback',
    'https://app.hanji.dev/notion/callback#code',
    'not-a-url',
  ]) {
    const invalid = validateProductionEnvironment(completeProductionEnvironment({
      ...notionOauth,
      HANJI_NOTION_OAUTH_REDIRECT_URI: redirectUri,
    }));
    assert.ok(invalid.errors.some((error) =>
      error.includes('HANJI_NOTION_OAUTH_REDIRECT_URI must exactly equal')));
  }

  const disabledWithRetainedSecret = validateProductionEnvironment(
    completeProductionEnvironment({
      HANJI_NOTION_OAUTH_ENABLED: 'false',
      HANJI_NOTION_OAUTH_CLIENT_SECRET: testSecret('retained-notion-oauth'),
    }),
  );
  assert.ok(disabledWithRetainedSecret.errors.some((error) => error.includes('Notion OAuth is disabled')));

  const enabledButIncomplete = validateProductionEnvironment(
    completeProductionEnvironment({ HANJI_NOTION_OAUTH_ENABLED: 'true' }),
  );
  assert.ok(enabledButIncomplete.errors.some((error) => error.includes('Notion OAuth is enabled')));
});

test('production validation pins Notion API/auth endpoints and strict safe overrides', () => {
  for (const overrides of [
    { HANJI_NOTION_API_BASE: 'https://notion-proxy.hanji.dev/v1' },
    { HANJI_NOTION_API_BASE: 'https://api.notion.com/v1/' },
    { HANJI_NOTION_OAUTH_AUTH_URL: 'https://notion-proxy.hanji.dev/oauth/authorize' },
    { HANJI_SSRF_DOH_URL: 'https://dns.google/resolve' },
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment(overrides));
    assert.ok(result.errors.some((error) => Object.keys(overrides).some((name) => error.includes(name))));
  }

  for (const name of [
    'HANJI_NOTION_API_BASE',
    'HANJI_NOTION_OAUTH_AUTH_URL',
    'HANJI_NOTION_OAUTH_ENABLED',
    'HANJI_SSRF_DOH_URL',
    'HANJI_SSRF_DNS_CHECK',
    'HANJI_RATE_LIMIT_PROFILE',
    'HANJI_ALLOW_DEV_GUEST_LOGIN',
    'HANJI_MASTER_DEV_AUTOLOGIN',
    'HANJI_SPONSORS_FEED_URL',
    'HANJI_INSTANCE_ADMIN_USER_IDS',
    'HANJI_AUTH_OAUTH_PROVIDERS',
    'HANJI_DEBUG_ROOM_ACCESS',
    'HANJI_MCP_TRUST_PROXY_HEADERS',
  ]) {
    const result = validateProductionEnvironment(
      completeProductionEnvironment({ ...explicitLegalUrls(), [name]: '' }),
      { requireLegalUrls: true },
    );
    assert.ok(result.errors.some((error) => error.includes(name)), name);
  }
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_NOTION_OAUTH_ENABLED: 'FALSE',
  })).errors.some((error) => error.includes('exactly true or false')));
  assert.ok(validateProductionEnvironment(completeProductionEnvironment({
    HANJI_INSTANCE_ADMIN_USER_IDS: 'OFF',
  })).errors.some((error) => error.includes('exact lowercase off')));
});

test('production validation bounds Notion import-job metadata retention', () => {
  for (const value of ['0', '-1', '1.5', '366', '999999999999999999999', 'Infinity', 'off']) {
    const result = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS: value,
    }));
    assert.ok(
      result.errors.some((error) => error.includes('HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS')),
      value,
    );
  }
});

test('OAuth provider names and credentials stay supported while UI uses runtime capabilities', () => {
  const supported = [
    'apple', 'discord', 'facebook', 'github', 'google', 'kakao', 'line',
    'microsoft', 'naver', 'reddit', 'slack', 'spotify', 'twitch', 'x',
  ];
  const frontendSource = readFileSync(resolve(repoRoot, 'web', 'src', 'lib', 'edgebase.ts'), 'utf8');
  const authGateSource = readFileSync(resolve(repoRoot, 'web', 'src', 'components', 'AuthGate.tsx'), 'utf8');
  const runtimeConfigSource = readFileSync(resolve(repoRoot, 'backend', 'functions', 'runtime-config.ts'), 'utf8');
  assert.doesNotMatch(frontendSource, /VITE_AUTH_OAUTH_PROVIDERS/);
  assert.match(authGateSource, /config\.oauthProviders/);
  assert.match(runtimeConfigSource, /oauthProviders:\s*publicOAuthProviders\(context\.env\)/);
  assert.ok(!validateProductionEnvironment(completeProductionEnvironment())
    .errors.some((error) => error.toLowerCase().includes('oauth')));
  for (const provider of supported) {
    assert.match(frontendSource, new RegExp(`\\b${provider}:\\s*["']`));
    const key = provider.toUpperCase();
    const result = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_AUTH_OAUTH_PROVIDERS: provider,
      [`HANJI_OAUTH_${key}_CLIENT_ID`]: `${provider}-client-id`,
      [`HANJI_OAUTH_${key}_CLIENT_SECRET`]: testSecret(`${provider}-oauth`),
    }));
    assert.ok(!result.errors.some((error) => error.toLowerCase().includes('oauth')), provider);
  }

  const unsupported = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_AUTH_OAUTH_PROVIDERS: 'unknown-provider',
  }));
  assert.ok(unsupported.errors.some((error) => error.includes('Unsupported OAuth provider')));

  const duplicate = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_AUTH_OAUTH_PROVIDERS: 'github,github',
    HANJI_OAUTH_GITHUB_CLIENT_ID: 'github-client-id',
    HANJI_OAUTH_GITHUB_CLIENT_SECRET: testSecret('github-oauth'),
  }));
  assert.ok(duplicate.errors.some((error) => error.includes('Duplicate OAuth provider')));

  const weak = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_AUTH_OAUTH_PROVIDERS: 'github',
    HANJI_OAUTH_GITHUB_CLIENT_ID: 'github-client-id',
    HANJI_OAUTH_GITHUB_CLIENT_SECRET: 'weak-secret',
  }));
  assert.ok(weak.errors.some((error) => error.includes('OAuth client secret for github')));
});

test('JWT rotation fallback secrets require a valid bounded timestamp pair', () => {
  const now = Date.parse('2026-07-12T12:00:00.000Z');
  const valid = validateProductionEnvironment(completeProductionEnvironment({
    JWT_USER_SECRET_OLD: testSecret('old-user'),
    JWT_USER_SECRET_OLD_AT: '2026-07-11T12:00:00.000Z',
  }), { now });
  assert.ok(!valid.errors.some((error) => error.includes('JWT_USER_SECRET_OLD')));

  for (const overrides of [
    { JWT_USER_SECRET_OLD: testSecret('old-user'), JWT_USER_SECRET_OLD_AT: '' },
    { JWT_USER_SECRET_OLD: '', JWT_USER_SECRET_OLD_AT: '2026-07-11T12:00:00.000Z' },
    { JWT_USER_SECRET_OLD: testSecret('old-user'), JWT_USER_SECRET_OLD_AT: 'not-a-date' },
    { JWT_USER_SECRET_OLD: testSecret('old-user'), JWT_USER_SECRET_OLD_AT: '2026-07-13T12:00:00.000Z' },
    { JWT_USER_SECRET_OLD: testSecret('old-user'), JWT_USER_SECRET_OLD_AT: '2026-06-01T12:00:00.000Z' },
    { JWT_USER_SECRET_OLD: testSecret('user'), JWT_USER_SECRET_OLD_AT: '2026-07-11T12:00:00.000Z' },
  ]) {
    const result = validateProductionEnvironment(completeProductionEnvironment(overrides), { now });
    assert.ok(result.errors.some((error) => error.includes('JWT_USER_SECRET_OLD')), JSON.stringify(overrides));
  }
});

test('strict build provenance requires a full matching immutable Git object ID and source path', () => {
  const short = validateProductionEnvironment(completeProductionEnvironment({
    ...explicitLegalUrls('abcdef1'),
    HANJI_BUILD_SHA: 'abcdef1',
  }), { requireLegalUrls: true });
  assert.ok(short.errors.some((error) => error.includes('full 40- or 64-character')));

  const mismatch = validateProductionEnvironment(completeProductionEnvironment({
    ...explicitLegalUrls(),
  }), { requireLegalUrls: true, expectedBuildSha: 'f'.repeat(40) });
  assert.ok(mismatch.errors.some((error) => error.includes('current public Git HEAD')));

  const unpinnedSource = validateProductionEnvironment(completeProductionEnvironment({
    ...explicitLegalUrls(),
    HANJI_SOURCE_URL: 'https://legal.hanji.dev/revision/latest',
  }), { requireLegalUrls: true });
  assert.ok(unpinnedSource.errors.some((error) => error.includes('exact full HANJI_BUILD_SHA')));

  assert.deepEqual(strictGitCheckoutErrors({ head: currentGitHead, status: '' }), []);
  assert.ok(strictGitCheckoutErrors({ head: currentGitHead, status: ' M tracked-file\n' })
    .some((error) => error.includes('clean public Git worktree')));
  assert.ok(strictGitCheckoutErrors({ head: '', status: null })
    .some((error) => error.includes('readable public Git checkout')));
});

test('production validation rejects active pre-Hanji environment names even when canonical values exist', () => {
  const formerPrefix = ['NOTION', 'LIKE_'].join('');
  const result = validateProductionEnvironment(completeProductionEnvironment({
    [`${formerPrefix}APP_ORIGIN`]: 'https://legacy.example.com',
  }));

  assert.ok(result.errors.some((error) =>
    error.includes('Pre-Hanji environment variable names are not permitted for a release')));
  assert.ok(result.errors.some((error) => error.includes(`${formerPrefix}APP_ORIGIN`)));
  assert.ok(result.errors.every((error) => !error.includes('legacy.example.com')));
});

test('production validation requires browser setup or a complete legacy master pair', () => {
  const partialMaster = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_MASTER_EMAIL: '',
    HANJI_MASTER_PASSWORD: 'short',
  }));
  assert.ok(partialMaster.errors.some((error) => error.includes('must both be empty')));

  const missingBrowserSetup = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_BROWSER_SETUP: 'false',
    HANJI_BROWSER_SETUP_TOKEN: '',
    HANJI_MASTER_EMAIL: '',
    HANJI_MASTER_PASSWORD: '',
  }));
  assert.ok(missingBrowserSetup.errors.some((error) => error.includes('Enable HANJI_BROWSER_SETUP')));

  const browserSetup = validateProductionEnvironment(completeProductionEnvironment({
    HANJI_MASTER_EMAIL: '',
    HANJI_MASTER_PASSWORD: '',
  }));
  assert.ok(!browserSetup.errors.some((error) => /MASTER_EMAIL|MASTER_PASSWORD/.test(error)));
  assert.ok(!browserSetup.errors.some((error) => error.includes('HANJI_BROWSER_SETUP_TOKEN')));
});

test('production validation rejects placeholder secrets and implicit admin bootstrap', () => {
  const result = validateProductionEnvironment({
    JWT_USER_SECRET: 'change-me',
    JWT_ADMIN_SECRET: '',
    HANJI_APP_ORIGIN: 'http://localhost:8787',
  });

  assert.ok(result.errors.some((error) => error.includes('JWT_USER_SECRET')));
  assert.ok(result.errors.some((error) => error.includes('instance-admin')));
  assert.ok(result.errors.some((error) => error.includes('public HTTPS origin')));
});

test('production validation rejects unverified instance-admin email allowlists', () => {
  for (const name of ['HANJI_INSTANCE_ADMIN_EMAILS', 'EDGEBASE_INSTANCE_ADMIN_EMAILS']) {
    const result = validateProductionEnvironment(completeProductionEnvironment({
      [name]: 'admin@example.com',
    }));
    assert.ok(result.errors.some((error) => error.includes('email allowlists are retired')));
  }
});

test('production validation rejects the development anonymous-auth route', () => {
  for (const enabled of ['1', 'true', 'YES']) {
    const result = validateProductionEnvironment({
      HANJI_ALLOW_DEV_GUEST_LOGIN: enabled,
    });
    assert.ok(result.errors.some((error) => error.includes('HANJI_ALLOW_DEV_GUEST_LOGIN')));
  }

  const formerPrefix = ['NOTION', 'LIKE_'].join('');
  const legacyResult = validateProductionEnvironment({
    [`${formerPrefix}ALLOW_DEV_GUEST_LOGIN`]: 'true',
  });
  assert.ok(legacyResult.errors.some((error) => error.includes('HANJI_ALLOW_DEV_GUEST_LOGIN')));
});

test('production validation rejects the retired anonymous-bootstrap alias', () => {
  for (const enabled of ['1', 'true', 'YES', 'on']) {
    const result = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_ALLOW_ANONYMOUS_BOOTSTRAP: enabled,
    }));
    assert.ok(result.errors.some((error) => error.includes('HANJI_ALLOW_ANONYMOUS_BOOTSTRAP')));
  }
});

test('production validation rejects the retired master credential auto-login flag', () => {
  for (const enabled of ['1', 'true', 'YES']) {
    const result = validateProductionEnvironment({
      HANJI_MASTER_DEV_AUTOLOGIN: enabled,
    });
    assert.ok(result.errors.some((error) => error.includes('HANJI_MASTER_DEV_AUTOLOGIN')));
  }
});

test('production validation rejects disabling caller-supplied URL DNS verification', () => {
  for (const disabled of ['off', 'false', '0']) {
    const result = validateProductionEnvironment({
      HANJI_SSRF_DNS_CHECK: disabled,
    });
    assert.ok(result.errors.some((error) => error.includes('HANJI_SSRF_DNS_CHECK')));
  }

  for (const enabled of ['', 'on', 'true']) {
    const result = validateProductionEnvironment({
      HANJI_SSRF_DNS_CHECK: enabled,
    });
    assert.ok(!result.errors.some((error) => error.includes('HANJI_SSRF_DNS_CHECK')));
  }
});

test('production validation rejects unsafe legal links and replacement sponsor feeds', () => {
  const result = validateProductionEnvironment({
    HANJI_SOURCE_URL: 'http://source.example/revision',
    HANJI_AGPL_LICENSE_URL: 'https://[fd00::1]/LICENSE',
    HANJI_SPONSOR_EXCEPTION_URL: 'https://user:password@example.com/LICENSE-EXCEPTION',
    HANJI_SPONSORS_FEED_URL: 'https://ads.example/sponsors',
  });

  assert.ok(result.errors.some((error) => error.includes('HANJI_SOURCE_URL')));
  assert.ok(result.errors.some((error) => error.includes('HANJI_AGPL_LICENSE_URL')));
  assert.ok(result.errors.some((error) => error.includes('HANJI_SPONSOR_EXCEPTION_URL')));
  assert.ok(result.errors.some((error) => error.includes('replacement feeds')));

  const mappedLoopback = validateProductionEnvironment({
    HANJI_SOURCE_URL: 'https://[::ffff:127.0.0.1]/source',
    HANJI_AGPL_LICENSE_URL: 'https://localhost./LICENSE',
  });
  assert.ok(mappedLoopback.errors.some((error) => error.includes('HANJI_SOURCE_URL')));
  assert.ok(mappedLoopback.errors.some((error) => error.includes('HANJI_AGPL_LICENSE_URL')));

  for (const supportedMode of ['', 'bundled', 'off']) {
    const supported = validateProductionEnvironment(completeProductionEnvironment({
      HANJI_SPONSORS_FEED_URL: supportedMode,
    }));
    assert.ok(!supported.errors.some((error) => error.includes('HANJI_SPONSORS_FEED_URL')));
  }
});

test('strict release validation requires all three explicit legal URLs', () => {
  const result = validateProductionEnvironment(completeProductionEnvironment(), {
    requireLegalUrls: true,
  });

  for (const name of LEGAL_URL_NAMES) {
    assert.ok(result.errors.some((error) => error.includes(name)));
  }
});

test('strict release env file must be regular, private, and declare every safety key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hanji-release-env-file-'));
  try {
    const env = completeProductionEnvironment(explicitLegalUrls());
    const envFile = writeStrictReleaseEnv(directory, env);
    assert.deepEqual(strictReleaseEnvFileErrors(envFile, env), []);

    chmodSync(envFile, 0o400);
    assert.deepEqual(strictReleaseEnvFileErrors(envFile, env), []);

    chmodSync(envFile, 0o644);
    assert.ok(strictReleaseEnvFileErrors(envFile, env).some((error) => error.includes('0600 or read-only 0400')));

    chmodSync(envFile, 0o600);
    const missing = { ...env };
    delete missing.HANJI_NOTION_API_BASE;
    assert.ok(strictReleaseEnvFileErrors(envFile, missing).some((error) => error.includes('HANJI_NOTION_API_BASE')));

    const symlink = join(directory, 'release-link.env');
    symlinkSync(envFile, symlink);
    assert.ok(strictReleaseEnvFileErrors(symlink, env).some((error) => error.includes('symlink or directory')));
    assert.ok(strictReleaseEnvFileErrors(directory, env).some((error) => error.includes('symlink or directory')));
    assert.ok(strictReleaseEnvFileErrors(join(directory, 'missing.env'), {}).some((error) => error.includes('regular')));
  } finally {
    chmodSync(join(directory, '.env.release'), 0o600);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict origin resolution rejects public-looking domains mapped to private addresses', async () => {
  const privateResult = await verifyProductionOriginsResolve(completeProductionEnvironment(), {
    resolveHost: async () => [{ address: '10.0.0.7', family: 4 }],
  });
  assert.ok(privateResult.errors.some((error) => error.includes('HANJI_APP_ORIGIN')));

  const mixedResult = await verifyProductionOriginsResolve(completeProductionEnvironment({
    HANJI_PASSKEY_RP_ID: 'hanji.dev',
    HANJI_PASSKEY_ORIGINS: 'https://app.hanji.dev,https://login.hanji.dev',
  }), {
    resolveHost: async (hostname) => hostname === 'login.hanji.dev'
      ? [{ address: '192.168.1.2', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
  });
  assert.ok(mixedResult.errors.some((error) => error.includes('HANJI_PASSKEY_ORIGINS')));

  const publicResult = await verifyProductionOriginsResolve(completeProductionEnvironment(), {
    resolveHost: resolvePublicTestAddress,
  });
  assert.deepEqual(publicResult.errors, []);
});

test('release validation rejects one URL masquerading as multiple legal artifacts', () => {
  const shared = 'https://legal.hanji.dev/revision';
  const result = validateProductionEnvironment(
    completeProductionEnvironment({
      HANJI_SOURCE_URL: shared,
      HANJI_AGPL_LICENSE_URL: `${shared}#license`,
      HANJI_SPONSOR_EXCEPTION_URL: `${shared}#exception`,
    }),
    { requireLegalUrls: true },
  );

  assert.equal(result.errors.filter((error) => error.includes('must not duplicate')).length, 2);
});

test('legal URL reachability uses bounded HEAD probes with a GET fallback', async () => {
  const methods = [];
  const result = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (url, init) => {
      methods.push(init.method);
      return new Response(init.method === 'HEAD' ? null : legalArtifactBody(url), {
        status: init.method === 'HEAD' ? 403 : 206,
      });
    },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(methods.filter((method) => method === 'HEAD').length, 3);
  assert.equal(methods.filter((method) => method === 'GET').length, 3);
});

test('legal URL reachability rejects failed responses and private redirects', async () => {
  const legalUrls = explicitLegalUrls();
  const result = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (input, init) => {
      const path = new URL(input).pathname;
      if (path.endsWith('/LICENSE')) return new Response(null, { status: 404 });
      if (input.toString() === legalUrls.HANJI_SOURCE_URL) {
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://127.0.0.1/private' },
        });
      }
      return new Response(init.method === 'HEAD' ? null : legalArtifactBody(input), { status: 200 });
    },
  });

  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.some((error) => error.includes('HANJI_SOURCE_URL')));
  assert.ok(result.errors.some((error) => error.includes('HANJI_AGPL_LICENSE_URL')));
});

test('legal URL reachability rejects empty, mislabeled, and duplicate final artifacts', async () => {
  const empty = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (input, init) => new Response(
      init.method === 'HEAD' ? null : (
        new URL(input).pathname.endsWith('/LICENSE') ? '' : legalArtifactBody(input)
      ),
      { status: init.method === 'HEAD' ? 200 : 206 },
    ),
  });
  assert.ok(empty.errors.some((error) => error.includes('HANJI_AGPL_LICENSE_URL')));

  const wrongMarker = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (input, init) => new Response(
      init.method === 'HEAD' ? null : 'ordinary HTML without a license marker',
      { status: init.method === 'HEAD' ? 200 : 206 },
    ),
  });
  assert.ok(wrongMarker.errors.some((error) => error.includes('HANJI_AGPL_LICENSE_URL')));
  assert.ok(wrongMarker.errors.some((error) => error.includes('HANJI_SPONSOR_EXCEPTION_URL')));

  const sharedFinal = 'https://legal.hanji.dev/final-artifact';
  const duplicate = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (input, init) => {
      const url = input.toString();
      if (url !== sharedFinal) {
        return new Response(null, { status: 302, headers: { Location: sharedFinal } });
      }
      const body = [
        'Hanji exact corresponding source artifact',
        'GNU AFFERO GENERAL PUBLIC LICENSE Version 3',
        'Hanji Sponsor Banner Exception AGPL-3.0',
      ].join('\n');
      return new Response(init.method === 'HEAD' ? null : body, { status: 200 });
    },
  });
  assert.equal(duplicate.errors.filter((error) => error.includes('same final artifact')).length, 2);
});

test('legal URL body reads retain a hard timeout after response headers arrive', async () => {
  const startedAt = Date.now();
  const result = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    timeoutMs: 20,
    resolveHost: resolvePublicTestAddress,
    fetchImpl: async (_input, init) => {
      if (init.method === 'HEAD') return new Response(null, { status: 200 });
      return new Response(new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
      }), { status: 200 });
    },
  });
  assert.equal(result.errors.length, 3);
  assert.ok(Date.now() - startedAt < 1_000, 'stalled response bodies must stay deadline-bounded');
});

test('legal URL reachability bounds DNS resolution', async () => {
  const result = await verifyLegalUrlsReachable(explicitLegalUrls(), {
    timeoutMs: 5,
    resolveHost: async () => await new Promise(() => {}),
    fetchImpl: async () => new Response(null, { status: 200 }),
  });

  assert.equal(result.errors.length, 3);
});

test('ordinary release preflight remains network-independent', async () => {
  let fetchCalls = 0;
  await runPreflight({
    envFile: resolve('.edgebase', 'missing-release-preflight.env'),
    runtimeEnv: {},
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not be called');
    },
  });
  assert.equal(fetchCalls, 0);
});

test('strict release preflight validates the environment and probes every legal URL', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hanji-release-preflight-'));
  const runtimeEnv = completeProductionEnvironment(explicitLegalUrls());
  const envFile = writeStrictReleaseEnv(
    directory,
    Object.fromEntries(Object.keys(runtimeEnv).map((name) => [name, ''])),
  );
  let fetchCalls = 0;
  try {
    const result = await runPreflight({
      strictRelease: true,
      envFile,
      runtimeEnv,
      gitCheckoutState: { head: currentGitHead, status: '' },
      resolveHost: resolvePublicTestAddress,
      fetchImpl: async (input, init) => {
        fetchCalls += 1;
        return new Response(init.method === 'HEAD' ? null : legalArtifactBody(input), { status: 200 });
      },
    });

    assert.deepEqual(result.errors, []);
    assert.equal(fetchCalls, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('strict release CLI mode implies environment and reachability checks', () => {
  const ordinary = parsePreflightArgs([]);
  const strict = parsePreflightArgs(['--strict-release']);
  assert.equal(ordinary.requireEnv, false);
  assert.equal(ordinary.strictRelease, false);
  assert.equal(strict.requireEnv, true);
  assert.equal(strict.strictRelease, true);
  assert.equal(strict.envFile, ordinary.envFile);
  assert.match(ordinary.envFile, /[/\\]backend[/\\]\.env\.release$/);
});
