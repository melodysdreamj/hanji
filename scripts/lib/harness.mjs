// Shared smoke-test harness for the standalone scripts under scripts/.
//
// Policy: NEW smoke/verification scripts must import these helpers instead of
// copying sign-in / function-call / Playwright-loading / assertion boilerplate.
// Existing scripts are migrated opportunistically when they are touched for
// other reasons. Behavior-affecting changes to this module must rerun at least
// one CI-gated API smoke (e.g. `npm --prefix backend run verify:collaboration`)
// and one visual smoke before landing.
//
// The implementations mirror the majority variants that existed across the
// copied helpers (see docs/work-ledger.md, Verification / CI, 2026-07-06).
// Minority behaviors are supported through optional parameters instead of
// being dropped (e.g. `includeBodyInError` for request-body error context).

import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';

let defaultTimeoutMs = 8_000;

/**
 * Set the module-wide default request timeout. Call once after parsing script
 * arguments (e.g. `setDefaultTimeoutMs(options.timeoutMs)`); every network
 * helper falls back to this value when no per-call `timeoutMs` is given.
 */
export function setDefaultTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('setDefaultTimeoutMs requires a positive number');
  }
  defaultTimeoutMs = timeoutMs;
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

export function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

export async function fetchWithTimeout(url, init = {}, { timeoutMs = defaultTimeoutMs } = {}) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 200)}`);
  }
}

export async function assertRuntimeReachable(baseUrl, { timeoutMs = 5_000 } = {}) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  }, { timeoutMs });
  const body = await response.text();
  assert(response.ok, `/api/health returned HTTP ${response.status}: ${body.slice(0, 200)}`);
}

/**
 * Anonymous sign-in. Returns the union of the shapes the copied variants
 * produced: `{ token, accessToken, refreshToken, userId, user }` where
 * `token === accessToken`, so API smokes (`token`/`userId`) and visual smokes
 * (`accessToken`/`refreshToken`) both work unchanged.
 */
/**
 * Master account credentials for smokes/tools. The dev server reads them from
 * backend/.dev.vars (written by scripts/setup-dev-env.mjs), so resolve in the
 * same order the runtime effectively sees: explicit env → backend/.dev.vars →
 * the CI defaults (CI exports these same values before booting the runtime).
 */
export function masterCredentials() {
  const fromEnv = {
    email: process.env.HANJI_MASTER_EMAIL?.trim(),
    password: process.env.HANJI_MASTER_PASSWORD?.trim(),
  };
  if (fromEnv.email && fromEnv.password) return fromEnv;
  try {
    const raw = readFileSync(new URL('../../backend/.dev.vars', import.meta.url), 'utf8');
    const read = (name) =>
      raw
        .split('\n')
        .find((line) => line.startsWith(`${name}=`))
        ?.slice(name.length + 1)
        .trim();
    const email = fromEnv.email || read('HANJI_MASTER_EMAIL');
    const password = fromEnv.password || read('HANJI_MASTER_PASSWORD');
    if (email && password) return { email, password };
  } catch {
    // No local dev vars (e.g. CI without the setup script) — fall through.
  }
  return {
    email: fromEnv.email || 'master@hanji.local',
    password: fromEnv.password || 'HanjiMaster!2026',
  };
}

export async function signIn(baseUrl, { timeoutMs } = {}) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  }, { timeoutMs });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  const token = body?.accessToken;
  const refreshToken = body?.refreshToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof refreshToken === 'string' && refreshToken, 'anonymous sign-in must return a refresh token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, accessToken: token, refreshToken, userId, user: body.user };
}

/**
 * Seed a Playwright browser context from an API-created auth session. The first
 * use migrates the legacy body refresh token through the real Web SDK; later
 * contexts receive the server-issued HttpOnly cookie plus a non-secret user-id
 * marker needed to trigger SDK revalidation. The cookie value is never
 * injected into application JavaScript.
 */
export function browserAuthStorageKeys(authOrigin, authNamespace) {
  const canonicalAuthBaseUrl = new URL(authOrigin).toString().replace(/\/$/, '');
  const prefix = authNamespace?.trim()
    ? `edgebase:${authNamespace.trim()}`
    : `edgebase:${encodeURIComponent(canonicalAuthBaseUrl)}`;
  return {
    prefix,
    refreshTokenKey: `${prefix}:refresh-token`,
    cookieSessionKey: `${prefix}:cookie-session`,
  };
}

export async function installBrowserSession(
  context,
  session,
  {
    appOrigin = DEFAULT_BASE_URL,
    authOrigin = appOrigin,
    authNamespace,
    workspaceId = session?.workspaceId,
    localStorage = {},
  } = {},
) {
  const allowedOrigin = new URL(appOrigin).origin;
  const allowedAuthOrigin = new URL(authOrigin).origin;
  const { prefix: authStoragePrefix, refreshTokenKey, cookieSessionKey } =
    browserAuthStorageKeys(authOrigin, authNamespace);
  const seedGuardKey = `hanji:harness:legacy-auth-seeded:${authStoragePrefix}`;
  const allowedHostname = new URL(allowedAuthOrigin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowedCookieNames = new Set([
    'hanji-refresh',
    '__Secure-hanji-refresh',
    session?.refreshCookieName,
  ].filter(Boolean));
  const cookies = Array.isArray(session?.browserCookies)
    ? session.browserCookies.filter((cookie) => {
      const cookieHostname = String(cookie?.domain ?? '').replace(/^\./, '').replace(/^\[|\]$/g, '').toLowerCase();
      return cookie?.httpOnly
        && cookie?.path === '/api/auth'
        && allowedCookieNames.has(cookie?.name)
        && cookieHostname === allowedHostname;
    })
    : [];
  if (cookies.length) await context.addCookies(cookies);

  await context.addInitScript(({
    appOrigin: origin,
    cookieSessionUserId,
    cookieSessionKey,
    legacyRefreshToken,
    refreshTokenKey,
    seedGuardKey,
    workspaceId: id,
    storage,
  }) => {
    // Playwright context init scripts execute in every top-level document and
    // child frame. Never expose a fixture credential or product storage value
    // to an external redirect/embed origin.
    if (window.location.origin !== origin) return;
    if (legacyRefreshToken) {
      // Context init scripts run for every document. Seed the migration token
      // exactly once so an SDK-cleaned secret is never reintroduced on reload
      // or when a second page opens in the same context.
      if (window.localStorage.getItem(seedGuardKey) !== '1') {
        window.localStorage.setItem(seedGuardKey, '1');
        window.localStorage.setItem(refreshTokenKey, legacyRefreshToken);
      }
    }
    if (cookieSessionUserId) {
      window.localStorage.setItem(cookieSessionKey, JSON.stringify({
        version: 1,
        userId: cookieSessionUserId,
      }));
    }
    if (id) window.localStorage.setItem('hanji.workspaceId', id);
    for (const [key, value] of Object.entries(storage)) {
      if (value === null || value === undefined) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, String(value));
    }
  }, {
    appOrigin: allowedOrigin,
    cookieSessionUserId: cookies.length ? session?.userId ?? session?.user?.id ?? '' : '',
    cookieSessionKey,
    legacyRefreshToken: cookies.length ? '' : session?.refreshToken ?? '',
    refreshTokenKey,
    seedGuardKey,
    workspaceId: workspaceId ?? '',
    storage: localStorage,
  });
}

/** Capture only the HttpOnly auth cookie needed to continue a smoke session. */
export async function captureBrowserSession(
  context,
  session,
  { appOrigin = DEFAULT_BASE_URL, authOrigin = appOrigin } = {},
) {
  if (!session) return [];
  const allowedAuthOrigin = new URL(authOrigin).origin;
  const allowedHostname = new URL(allowedAuthOrigin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const authCookieUrl = new URL('/api/auth/refresh', `${allowedAuthOrigin}/`).toString();
  const allowedCookieNames = new Set([
    'hanji-refresh',
    '__Secure-hanji-refresh',
    session?.refreshCookieName,
  ].filter(Boolean));
  const cookies = (await context.cookies(authCookieUrl)).filter((cookie) => {
    const cookieHostname = String(cookie?.domain ?? '').replace(/^\./, '').replace(/^\[|\]$/g, '').toLowerCase();
    return cookie.httpOnly
      && cookie.path === '/api/auth'
      && allowedCookieNames.has(cookie.name)
      && cookieHostname === allowedHostname;
  });
  // Keep the last known hand-off when nothing was captured: a context that
  // never went online (offline-boot smokes) has no rotated cookie, and
  // clobbering the previous one would force the next context back onto the
  // already-rotated legacy token (reuse detection would revoke the family).
  if (cookies.length) session.browserCookies = cookies;
  return cookies;
}

export async function postFunction(baseUrl, token, name, body, { timeoutMs, headers } = {}) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(headers ?? {}),
    },
    body: JSON.stringify(body ?? {}),
  }, { timeoutMs });
}

/**
 * Authenticated product-function call. Throws on non-2xx responses.
 * Pass `includeBodyInError: true` to add the request body to failure messages
 * (the variant used by e.g. public-share and database-relation smokes).
 */
export async function callFunction(baseUrl, token, name, body, options = {}) {
  const response = await postFunction(baseUrl, token, name, body, options);
  const json = await readJson(response);
  if (!response.ok) {
    const context = options.includeBodyInError
      ? ` for ${JSON.stringify(body).slice(0, 300)}`
      : '';
    throw new Error(`${name} returned HTTP ${response.status}${context}: ${JSON.stringify(json)}`);
  }
  return json;
}

function permanentDeleteOptions(options) {
  if (typeof options === 'number') return { call: callFunction, callOptions: { timeoutMs: options } };
  const { call = callFunction, ...callOptions } = options ?? {};
  return { call, callOptions };
}

function callPermanentMutation(call, baseUrl, token, name, body, callOptions) {
  return Object.keys(callOptions).length > 0
    ? call(baseUrl, token, name, body, callOptions)
    : call(baseUrl, token, name, body);
}

/**
 * Permanently delete a page only after explicitly placing its root subtree in
 * trash. `call` can be overridden by long-running smokes that need their own
 * retry wrapper; all other request options are forwarded to both mutations.
 */
export async function permanentlyDeletePage(baseUrl, token, id, options = {}) {
  const { call, callOptions } = permanentDeleteOptions(options);
  await callPermanentMutation(call, baseUrl, token, 'page-mutation', { action: 'trash', id }, callOptions);
  return callPermanentMutation(call, baseUrl, token, 'page-mutation', { action: 'delete', id }, callOptions);
}

/** Permanently delete a database row after explicitly placing it in trash. */
export async function permanentlyDeleteDatabaseRow(baseUrl, token, id, options = {}) {
  const { call, callOptions } = permanentDeleteOptions(options);
  await callPermanentMutation(call, baseUrl, token, 'database-row-mutation', { action: 'trash', id }, callOptions);
  return callPermanentMutation(call, baseUrl, token, 'database-row-mutation', { action: 'delete', id }, callOptions);
}

/** Unauthenticated product-function call. Throws on non-2xx responses. */
export async function callPublicFunction(baseUrl, name, body, options = {}) {
  const response = await postFunction(baseUrl, undefined, name, body, options);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} public call returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

/** Assert an authenticated call returns the exact HTTP status (e.g. 403). */
export async function expectFunctionStatus(baseUrl, token, name, body, status, options = {}) {
  const response = await postFunction(baseUrl, token, name, body, options);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/** Assert an unauthenticated call returns the exact HTTP status (e.g. 404). */
export async function expectPublicFunctionStatus(baseUrl, name, body, status, options = {}) {
  const response = await postFunction(baseUrl, undefined, name, body, options);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `${name} public call expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

/**
 * Load Playwright from this repo, PLAYWRIGHT_MODULE_DIR, or the local
 * EdgeBase workspace dependencies. `label` names the calling smoke in the
 * failure message.
 */
export async function loadPlaywright({ label = 'this smoke script' } = {}) {
  try {
    return await import('playwright');
  } catch {
    // Continue with local workspace fallbacks below.
  }

  const candidates = [
    process.env.PLAYWRIGHT_MODULE_DIR,
    join(repoRoot, 'node_modules', 'playwright'),
    join(repoRoot, 'web', 'node_modules', 'playwright'),
    join(repoRoot, 'backend', 'node_modules', 'playwright'),
    ...edgeBasePlaywrightCandidates(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const packageJson = join(candidate, 'package.json');
    if (!existsSync(packageJson)) continue;
    const require = createRequire(packageJson);
    return require('playwright');
  }

  throw new Error(
    `Playwright is required for ${label}. Install it in this repo, set PLAYWRIGHT_MODULE_DIR, or use the local EdgeBase workspace dependencies.`,
  );
}

export function edgeBasePlaywrightCandidates() {
  const edgebaseRoot = process.env.EDGEBASE_ROOT ?? new URL('../../../edgebase', import.meta.url).pathname;
  const direct = join(edgebaseRoot, 'node_modules', 'playwright');
  const pnpmRoot = join(edgebaseRoot, 'node_modules', '.pnpm');
  const candidates = [direct];

  if (existsSync(pnpmRoot)) {
    for (const entry of readdirSync(pnpmRoot)) {
      if (!entry.startsWith('playwright@')) continue;
      candidates.push(join(pnpmRoot, entry, 'node_modules', 'playwright'));
    }
  }

  return candidates;
}

/** Explicit Chromium/Chrome binary from the environment, if configured. */
export function resolveChromeExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  if (process.env.PLAYWRIGHT_CHROME_EXECUTABLE) return process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return undefined;
}

const GENERIC_HTTP_FAILURE_CONSOLE_PATTERN =
  /^Failed to load resource: the server responded with a status of (\d+) \([^)]+\)$/;

function authRefreshFailureStatus(response, allowedStatuses) {
  const status = response.status();
  if (!allowedStatuses.has(status)) return null;
  try {
    return new URL(response.url()).pathname === '/api/auth/refresh' ? status : null;
  } catch {
    return null;
  }
}

/**
 * Attach strict browser diagnostics to an existing Playwright page. When
 * an initial signed-out refresh allowance is enabled, only a generic console
 * error paired with an observed allowed status from `/api/auth/refresh` is
 * consumed, and only until `endInitialSignedOutRefreshWindow()` is called.
 * Later/repeated failures stay fatal. The legacy 401 option remains the safe
 * default; callers exercising an intentionally invalid Origin may opt into
 * `[400, 401]` for that one context.
 */
export function watchBrowserErrors(page, {
  errors = [],
  prefix = '',
  includeConsoleLocation = false,
  captureConnectionRefused = false,
  captureFunctionResponses = false,
  allowInitialSignedOutRefresh401 = false,
  allowInitialSignedOutRefreshStatuses,
} = {}) {
  const initialSignedOutStatuses = new Set(
    Array.isArray(allowInitialSignedOutRefreshStatuses)
      ? allowInitialSignedOutRefreshStatuses.filter(
          (status) => Number.isInteger(status) && status >= 400 && status <= 599,
        )
      : allowInitialSignedOutRefresh401
        ? [401]
        : [],
  );
  let initialSignedOutWindowOpen = initialSignedOutStatuses.size > 0;
  let initialSignedOutAllowanceAvailable = initialSignedOutStatuses.size > 0;
  let pendingSignedOutRefreshStatus = null;
  let pendingGenericAuthError = null;
  const record = (message) => errors.push(prefix ? `${prefix}${message}` : message);

  page.on('pageerror', (error) => record(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const genericStatus = Number(
      message.text().match(GENERIC_HTTP_FAILURE_CONSOLE_PATTERN)?.[1] ?? Number.NaN,
    );
    if (initialSignedOutWindowOpen && initialSignedOutStatuses.has(genericStatus)) {
      const consoleUrl = message.location?.().url;
      if (consoleUrl) {
        try {
          if (new URL(consoleUrl).pathname !== '/api/auth/refresh') {
            record(message.text());
            return;
          }
        } catch {
          record(message.text());
          return;
        }
      }
      const location = includeConsoleLocation ? message.location() : null;
      const source = location?.url ? ` (${location.url}:${location.lineNumber})` : '';
      const diagnostic = `${message.text()}${source}`;
      if (
        initialSignedOutAllowanceAvailable
        && pendingSignedOutRefreshStatus === genericStatus
      ) {
        pendingSignedOutRefreshStatus = null;
        initialSignedOutAllowanceAvailable = false;
      } else if (initialSignedOutAllowanceAvailable && !pendingGenericAuthError) {
        // Chromium may emit the console event just before Playwright's response
        // event. Hold it until the matching refresh response arrives or the
        // caller closes the initial-auth window.
        pendingGenericAuthError = { message: diagnostic, status: genericStatus };
      } else {
        record(diagnostic);
      }
      return;
    }
    if (includeConsoleLocation) {
      const location = message.location();
      const source = location.url ? ` (${location.url}:${location.lineNumber})` : '';
      record(`${message.text()}${source}`);
      return;
    }
    record(message.text());
  });
  if (captureConnectionRefused) {
    page.on('requestfailed', (request) => {
      const failure = request.failure()?.errorText ?? 'request failed';
      if (!failure.includes('CONNECTION_REFUSED')) return;
      record(`${failure} ${request.method()} ${request.url()}`);
    });
  }
  page.on('response', async (response) => {
    const refreshFailureStatus = initialSignedOutWindowOpen
      ? authRefreshFailureStatus(response, initialSignedOutStatuses)
      : null;
    if (refreshFailureStatus !== null) {
      if (
        initialSignedOutAllowanceAvailable
        && pendingGenericAuthError?.status === refreshFailureStatus
      ) {
        pendingGenericAuthError = null;
        initialSignedOutAllowanceAvailable = false;
      } else if (initialSignedOutAllowanceAvailable && pendingSignedOutRefreshStatus === null) {
        pendingSignedOutRefreshStatus = refreshFailureStatus;
      } else {
        record(`Unexpected repeated ${refreshFailureStatus} ${response.url()}`);
      }
    }
    if (!captureFunctionResponses || response.status() < 400 || !response.url().includes('/api/functions/')) {
      return;
    }
    const body = await response.text().catch(() => '');
    record(`${response.status()} ${response.url()}: ${body.slice(0, 300)}`);
  });

  return {
    errors,
    async endInitialSignedOutRefreshWindow() {
      // Let the browser deliver the response/console pair before sealing the
      // window. Callers await this before any sign-in click, so later failures
      // cannot consume the initial signed-out allowance.
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(75);
      else await new Promise((resolve) => setTimeout(resolve, 0));
      if (pendingGenericAuthError) record(pendingGenericAuthError.message);
      initialSignedOutWindowOpen = false;
      initialSignedOutAllowanceAvailable = false;
      pendingSignedOutRefreshStatus = null;
      pendingGenericAuthError = null;
    },
  };
}

/**
 * Open a new context+page that records page errors and console errors into
 * the returned `errors` array. Pair with `assertNoBrowserErrors`.
 */
export async function newCheckedPage(browser, contextOptions = {}, diagnostics = {}) {
  const context = await browser.newContext(contextOptions);
  // Smokes own their sign-in state. The dev runtime's master auto-login
  // (HANJI_MASTER_DEV_AUTOLOGIN) must never race a smoke that expects
  // the AuthGate form or seeds its own session, so every harness context
  // opts out via the AuthGate escape flag.
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('hanji:disable-master-autologin', '1');
    } catch {
      // Storage can be unavailable in exotic contexts; the smoke then relies
      // on its own navigation/query-param control instead.
    }
  });
  const page = await context.newPage();
  const watcher = watchBrowserErrors(page, diagnostics);
  return { context, page, ...watcher };
}

export function assertNoBrowserErrors(errors, label) {
  if (errors.length) {
    throw new Error(`Browser errors while checking ${label}:\n- ${errors.join('\n- ')}`);
  }
}

/**
 * Land on the AuthGate password form. AuthGate has shown the password form
 * directly since the password-only IA change (work ledger 2026-07-04); older
 * builds exposed a "Password" method tab instead. Accept both shapes so
 * smokes don't pin the retired tab selector.
 */
export async function ensurePasswordAuthForm(page, timeoutMs = 20000) {
  const passwordField = page.getByLabel('Password', { exact: true }).first();
  if (await passwordField.isVisible().catch(() => false)) return;
  const tab = page.getByRole('tab', { name: 'Password' });
  if ((await tab.count().catch(() => 0)) > 0) {
    await tab.click({ timeout: timeoutMs });
    return;
  }
  await passwordField.waitFor({ state: 'visible', timeout: timeoutMs });
}
