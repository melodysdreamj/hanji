#!/usr/bin/env node

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = resolve(root, 'backend');
const requireFromBackend = createRequire(resolve(backendDir, 'package.json'));

export function parseEnvFile(text) {
  const values = {};
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator <= 0) {
      throw new Error(`Invalid environment assignment on line ${index + 1}.`);
    }
    const name = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      throw new Error(`Invalid environment variable name on line ${index + 1}: ${name}`);
    }
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  }
  return values;
}

export function releaseModeEnabled(source, typescript) {
  const file = typescript.createSourceFile(
    'edgebase.config.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );

  for (const statement of file.statements) {
    if (!typescript.isExportAssignment(statement)) continue;
    const call = statement.expression;
    if (!typescript.isCallExpression(call) || call.arguments.length !== 1) continue;
    if (!typescript.isIdentifier(call.expression) || call.expression.text !== 'defineConfig') continue;
    const config = call.arguments[0];
    if (!typescript.isObjectLiteralExpression(config)) continue;
    const property = config.properties.find((candidate) =>
      typescript.isPropertyAssignment(candidate) &&
      ((typescript.isIdentifier(candidate.name) && candidate.name.text === 'release') ||
        (typescript.isStringLiteral(candidate.name) && candidate.name.text === 'release')),
    );
    return Boolean(
      property &&
      typescript.isPropertyAssignment(property) &&
      property.initializer.kind === typescript.SyntaxKind.TrueKeyword,
    );
  }
  return false;
}

function objectProperty(object, name, typescript) {
  if (!object || !typescript.isObjectLiteralExpression(object)) return null;
  const property = object.properties.find((candidate) =>
    typescript.isPropertyAssignment(candidate) &&
    ((typescript.isIdentifier(candidate.name) && candidate.name.text === name) ||
      (typescript.isStringLiteral(candidate.name) && candidate.name.text === name)),
  );
  return property && typescript.isPropertyAssignment(property) ? property.initializer : null;
}

function defineConfigObject(source, typescript) {
  const file = typescript.createSourceFile(
    'edgebase.config.ts',
    source,
    typescript.ScriptTarget.Latest,
    true,
    typescript.ScriptKind.TS,
  );
  for (const statement of file.statements) {
    if (!typescript.isExportAssignment(statement)) continue;
    const call = statement.expression;
    if (!typescript.isCallExpression(call) || call.arguments.length !== 1) continue;
    if (!typescript.isIdentifier(call.expression) || call.expression.text !== 'defineConfig') continue;
    const config = call.arguments[0];
    if (typescript.isObjectLiteralExpression(config)) return config;
  }
  return null;
}

export function secureBrowserSessionConfigured(source, typescript) {
  const config = defineConfigObject(source, typescript);
  const auth = objectProperty(config, 'auth', typescript);
  const session = objectProperty(auth, 'session', typescript);
  const cookie = objectProperty(session, 'cookie', typescript);
  const enabled = objectProperty(cookie, 'enabled', typescript);
  const name = objectProperty(cookie, 'name', typescript);
  const sameSite = objectProperty(cookie, 'sameSite', typescript);
  const cors = objectProperty(config, 'cors', typescript);
  const credentials = objectProperty(cors, 'credentials', typescript);
  const origins = objectProperty(cors, 'origin', typescript);

  if (enabled?.kind !== typescript.SyntaxKind.TrueKeyword) return false;
  if (!name || !typescript.isStringLiteral(name) || !name.text.trim()) return false;
  if (!sameSite || !typescript.isStringLiteral(sameSite) || sameSite.text !== 'strict') return false;
  if (credentials?.kind !== typescript.SyntaxKind.TrueKeyword) return false;
  if (!origins || !typescript.isArrayLiteralExpression(origins)) return false;
  return origins.elements.every((origin) => {
    // APP_ORIGIN is production-validated below as an exact public HTTPS origin
    // and is the only dynamic credential origin accepted by this guard.
    if (typescript.isIdentifier(origin) && origin.text === 'APP_ORIGIN') return true;
    if (!typescript.isStringLiteral(origin) || origin.text.includes('*')) return false;
    try {
      const parsed = new URL(origin.text);
      return (
        ['http:', 'https:'].includes(parsed.protocol) &&
        parsed.origin === origin.text &&
        parsed.pathname === '/' &&
        !parsed.search &&
        !parsed.hash
      );
    } catch {
      return false;
    }
  });
}

function value(env, name) {
  return typeof env[name] === 'string' ? env[name].trim() : '';
}

function isPlaceholder(input) {
  return /^(?:change[-_ ]?me|replace[-_ ]?me|todo|example|secret|xxx+|<.+>)$/i.test(input);
}

export function validateProductionEnvironment(env) {
  const errors = [];
  const warnings = [];
  const rateLimitProfile = value(env, 'NOTIONLIKE_RATE_LIMIT_PROFILE').toLowerCase();
  if (rateLimitProfile && rateLimitProfile !== 'production') {
    errors.push('NOTIONLIKE_RATE_LIMIT_PROFILE must be production for a release deploy.');
  }
  const requireStrongSecret = (name, minimum = 32) => {
    const input = value(env, name);
    if (!input || input.length < minimum || isPlaceholder(input)) {
      errors.push(`${name} must be a non-placeholder secret of at least ${minimum} characters.`);
    }
  };

  requireStrongSecret('JWT_USER_SECRET');
  requireStrongSecret('JWT_ADMIN_SECRET');
  requireStrongSecret('NOTIONLIKE_NOTION_IMPORT_SECRET');
  requireStrongSecret('NOTIONLIKE_MCP_OAUTH_SECRET');

  let appOrigin;
  try {
    appOrigin = new URL(value(env, 'NOTIONLIKE_APP_ORIGIN'));
    if (appOrigin.protocol !== 'https:' || ['localhost', '127.0.0.1', '::1'].includes(appOrigin.hostname)) {
      errors.push('NOTIONLIKE_APP_ORIGIN must be a public HTTPS origin.');
    }
    if (appOrigin.pathname !== '/' || appOrigin.search || appOrigin.hash) {
      errors.push('NOTIONLIKE_APP_ORIGIN must not include a path, query, or fragment.');
    }
  } catch {
    errors.push('NOTIONLIKE_APP_ORIGIN must be a valid public HTTPS origin.');
  }

  const rpId = value(env, 'NOTIONLIKE_PASSKEY_RP_ID').toLowerCase();
  if (!rpId || rpId.includes('://') || rpId === 'localhost') {
    errors.push('NOTIONLIKE_PASSKEY_RP_ID must be an explicit production domain.');
  } else if (appOrigin && appOrigin.hostname !== rpId && !appOrigin.hostname.endsWith(`.${rpId}`)) {
    errors.push('NOTIONLIKE_PASSKEY_RP_ID must equal or be a registrable suffix of the app hostname.');
  }

  const passkeyOrigins = value(env, 'NOTIONLIKE_PASSKEY_ORIGINS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!passkeyOrigins.length) {
    errors.push('NOTIONLIKE_PASSKEY_ORIGINS must explicitly list the production HTTPS origin.');
  } else {
    for (const origin of passkeyOrigins) {
      try {
        const parsed = new URL(origin);
        if (parsed.protocol !== 'https:' || parsed.origin !== origin.replace(/\/$/, '')) {
          errors.push(`Invalid passkey origin: ${origin}`);
        }
      } catch {
        errors.push(`Invalid passkey origin: ${origin}`);
      }
    }
    if (appOrigin && !passkeyOrigins.some((origin) => origin.replace(/\/$/, '') === appOrigin.origin)) {
      errors.push('NOTIONLIKE_PASSKEY_ORIGINS must include NOTIONLIKE_APP_ORIGIN.');
    }
  }

  const emailFrom = value(env, 'NOTIONLIKE_AUTH_EMAIL_FROM');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(emailFrom) || emailFrom.endsWith('@localhost')) {
    errors.push('NOTIONLIKE_AUTH_EMAIL_FROM must be a deliverable non-local email address.');
  }
  const emailBinding = value(env, 'NOTIONLIKE_CLOUDFLARE_EMAIL_BINDING');
  const emailAccount = value(env, 'NOTIONLIKE_CLOUDFLARE_EMAIL_ACCOUNT_ID');
  const emailToken = value(env, 'NOTIONLIKE_CLOUDFLARE_EMAIL_API_TOKEN');
  if (!emailBinding && !(emailAccount && emailToken)) {
    errors.push(
      'Configure NOTIONLIKE_CLOUDFLARE_EMAIL_BINDING or both Cloudflare email account ID and API token.',
    );
  }

  const adminIds = value(env, 'NOTIONLIKE_INSTANCE_ADMIN_USER_IDS');
  const adminEmails = value(env, 'NOTIONLIKE_INSTANCE_ADMIN_EMAILS');
  if (!adminIds && !adminEmails) {
    errors.push('Configure an explicit instance-admin user ID or email allowlist.');
  }

  const oauthProviders = value(env, 'NOTIONLIKE_AUTH_OAUTH_PROVIDERS')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  for (const provider of oauthProviders) {
    const key = provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    if (!value(env, `NOTIONLIKE_OAUTH_${key}_CLIENT_ID`)) {
      errors.push(`Missing OAuth client ID for ${provider}.`);
    }
    if (!value(env, `NOTIONLIKE_OAUTH_${key}_CLIENT_SECRET`)) {
      errors.push(`Missing OAuth client secret for ${provider}.`);
    }
  }

  const notionOauthFields = [
    'NOTIONLIKE_NOTION_OAUTH_CLIENT_ID',
    'NOTIONLIKE_NOTION_OAUTH_CLIENT_SECRET',
    'NOTIONLIKE_NOTION_OAUTH_REDIRECT_URI',
    'NOTIONLIKE_NOTION_OAUTH_STATE_SECRET',
  ];
  const configuredNotionOauth = notionOauthFields.filter((name) => value(env, name));
  if (configuredNotionOauth.length && configuredNotionOauth.length !== notionOauthFields.length) {
    errors.push('Notion OAuth is partially configured; set its client ID, client secret, redirect URI, and state secret together.');
  }
  if (!configuredNotionOauth.length) {
    warnings.push('Notion OAuth is disabled; imports require a user-supplied integration token.');
  }

  if (!value(env, 'NOTIONLIKE_BUILD_SHA')) {
    warnings.push('NOTIONLIKE_BUILD_SHA is unset; health output cannot identify the deployed revision.');
  }

  return { errors, warnings };
}

export function runPreflight({ requireEnv = false, envFile = resolve(backendDir, '.env.release') } = {}) {
  const configPath = resolve(backendDir, 'edgebase.config.ts');
  const source = readFileSync(configPath, 'utf8');
  const typescript = requireFromBackend('typescript');
  if (!releaseModeEnabled(source, typescript)) {
    throw new Error('backend/edgebase.config.ts must set top-level release: true.');
  }
  if (!secureBrowserSessionConfigured(source, typescript)) {
    throw new Error(
      'backend/edgebase.config.ts must enable the named Strict HttpOnly-cookie session transport with credentialed exact CORS origins.',
    );
  }

  const fileEnv = existsSync(envFile) ? parseEnvFile(readFileSync(envFile, 'utf8')) : {};
  const env = { ...fileEnv, ...process.env };
  const result = requireEnv ? validateProductionEnvironment(env) : { errors: [], warnings: [] };
  if (result.errors.length) {
    throw new Error(`Production environment preflight failed:\n- ${result.errors.join('\n- ')}`);
  }
  return result;
}

function parseArgs(args) {
  const options = { requireEnv: false, envFile: resolve(backendDir, '.env.release') };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--require-env') {
      options.requireEnv = true;
      continue;
    }
    if (arg === '--env-file') {
      const path = args[index + 1];
      if (!path || path.startsWith('--')) throw new Error('--env-file requires a path.');
      options.envFile = resolve(path);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runPreflight(parseArgs(process.argv.slice(2)));
    for (const warning of result.warnings) console.warn(`WARN ${warning}`);
    console.log('PASS release configuration preflight.');
  } catch (error) {
    console.error(`FAIL release configuration preflight: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
