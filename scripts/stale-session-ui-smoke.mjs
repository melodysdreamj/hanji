#!/usr/bin/env node

import {
  assert,
  assertNoBrowserErrors,
  assertRuntimeReachable,
  callFunction,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
} from './lib/harness.mjs';

const baseUrl = normalizeBaseUrl(
  process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787',
);
const timeoutMs = 20_000;
setDefaultTimeoutMs(timeoutMs);

try {
  await main();
} catch (error) {
  console.error(`\nFAIL stale session UI smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function main() {
  const url = new URL(baseUrl);
  assert(
    ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname),
    'stale session recovery smoke is restricted to a local development runtime',
  );
  await assertRuntimeReachable(baseUrl);

  const staleRefreshToken = unsignedFutureToken({
    sub: 'stale-session-user',
    role: 'user',
    type: 'refresh',
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { chromium } = await loadPlaywright({ label: 'stale session UI smoke' });
  const executablePath = resolveChromeExecutable();
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  let recovered = null;

  try {
    const { context, page, errors } = await newCheckedPage(browser, {
      viewport: { width: 1100, height: 850 },
      deviceScaleFactor: 1,
    });
    const notFoundResponses = [];
    const unauthorizedResponses = [];
    page.on('response', (response) => {
      if (response.status() === 404) notFoundResponses.push(response.url());
      if (response.status() === 401) unauthorizedResponses.push(response.url());
    });
    try {
      await context.addInitScript(({ refreshToken }) => {
        window.localStorage.setItem('edgebase:refresh-token', refreshToken);
        window.localStorage.setItem('notionlike.workspaceId', 'stale-session-workspace');
      }, { refreshToken: staleRefreshToken });
      await page.goto(resolveUrl(baseUrl, '/'), {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });
      const workspaceMenu = page.locator('button[aria-label="Open workspace menu"]');
      const guestButton = page.getByRole('button', { name: /^(?:Continue as guest|게스트로 계속)$/i });
      await guestButton.waitFor({
        state: 'visible',
        timeout: timeoutMs,
      });
      assert(
        !(await workspaceMenu.isVisible().catch(() => false)),
        'a rejected stale marker rendered private workspace UI before re-authentication',
      );
      await guestButton.click({ timeout: timeoutMs });
      await workspaceMenu.waitFor({ state: 'visible', timeout: timeoutMs });
      const browserCookies = await context.cookies(resolveUrl(baseUrl, '/api/auth/refresh'));
      const refreshCookie = browserCookies.find((cookie) =>
        cookie.name === 'notionlike-refresh' || cookie.name === '__Secure-notionlike-refresh'
      );
      recovered = await page.evaluate(async () => {
        const localStorageEntries = Object.entries(window.localStorage);
        const refreshResponse = await fetch('/api/auth/refresh', {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-EdgeBase-Auth-Transport': 'cookie',
          },
          body: '{}',
        });
        const refreshBody = await refreshResponse.json().catch(() => null);
        return {
          credentialStorageEntries: localStorageEntries.filter(([key, value]) =>
            /(?:refresh|access)[-_:\s]?token/i.test(key)
            || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
          ),
          documentCookie: document.cookie,
          workspaceId: window.localStorage.getItem('notionlike.workspaceId') ?? '',
          stillLoading: document.body.textContent?.includes('Loading your workspace')
            || document.body.textContent?.includes('워크스페이스를 불러오는 중'),
          refreshStatus: refreshResponse.status,
          refreshBody,
        };
      });
      assert(
        recovered.credentialStorageEntries.length === 0,
        `browser storage retained an auth credential: ${JSON.stringify(recovered.credentialStorageEntries)}`,
      );
      assert(refreshCookie, 'the recovered session did not set the refresh cookie');
      assert(refreshCookie.httpOnly === true, 'the refresh cookie is not HttpOnly');
      assert(refreshCookie.path === '/api/auth', `unexpected refresh cookie path: ${refreshCookie.path}`);
      assert(refreshCookie.sameSite === 'Strict', `unexpected refresh cookie SameSite: ${refreshCookie.sameSite}`);
      assert(
        !recovered.documentCookie.includes(refreshCookie.name),
        'application JavaScript could read the refresh cookie',
      );
      assert(recovered.refreshStatus === 200, `cookie refresh returned HTTP ${recovered.refreshStatus}`);
      assert(recovered.refreshBody?.accessToken, 'cookie refresh did not return an access token');
      assert(
        !Object.prototype.hasOwnProperty.call(recovered.refreshBody, 'refreshToken'),
        'cookie refresh exposed a refresh token in JSON',
      );
      assert(recovered.workspaceId && recovered.workspaceId !== 'stale-session-workspace', 'stale workspace cache was not replaced');
      assert(recovered.stillLoading !== true, 'workspace remained stuck on the loading screen');
      assert(
        errors.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)'),
        'stale refresh-token fixture did not exercise the rejected refresh path',
      );
      const expectedRefresh401s = unauthorizedResponses.filter((responseUrl) => {
        try {
          return new URL(responseUrl).pathname === '/api/auth/refresh';
        } catch {
          return false;
        }
      });
      const unexpected401s = unauthorizedResponses.filter((responseUrl) => !expectedRefresh401s.includes(responseUrl));
      assert(
        expectedRefresh401s.length === 1,
        `stale token fixture expected one auth refresh 401, got ${JSON.stringify(unauthorizedResponses)}`,
      );
      assert(unexpected401s.length === 0, `unexpected 401 responses: ${JSON.stringify(unexpected401s)}`);
      const expectedBootstrap404s = notFoundResponses.filter((responseUrl) => {
        try {
          return new URL(responseUrl).pathname === '/api/functions/workspace-bootstrap';
        } catch {
          return false;
        }
      });
      const unexpected404s = notFoundResponses.filter((responseUrl) => !expectedBootstrap404s.includes(responseUrl));
      assert(
        expectedBootstrap404s.length === 1,
        `stale workspace fixture expected one workspace-bootstrap 404, got ${JSON.stringify(notFoundResponses)}`,
      );
      assert(unexpected404s.length === 0, `unexpected 404 responses: ${JSON.stringify(unexpected404s)}`);
      let expectedGeneric401Allowance = expectedRefresh401s.length;
      let expectedGeneric404Allowance = expectedBootstrap404s.length;
      const unexpectedErrors = errors.filter((message) => {
        if (
          message === 'Failed to load resource: the server responded with a status of 401 (Unauthorized)'
          && expectedGeneric401Allowance > 0
        ) {
          expectedGeneric401Allowance -= 1;
          return false;
        }
        if (
          message === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
          && expectedGeneric404Allowance > 0
        ) {
          expectedGeneric404Allowance -= 1;
          return false;
        }
        return true;
      });
      assertNoBrowserErrors(
        unexpectedErrors,
        `stale session recovery (404 responses: ${JSON.stringify(notFoundResponses)})`,
      );
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }

  await cleanupRecoveredWorkspace(recovered).catch(() => {});
  console.log('PASS a stale browser token migrates/rejects safely, recovery uses an HttpOnly cookie, and no refresh credential remains in JavaScript storage.');
}

function unsignedFutureToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.invalid-signature`;
}

async function cleanupRecoveredWorkspace(recovered) {
  const accessToken = recovered?.refreshBody?.accessToken;
  if (!accessToken) return;
  const listed = await callFunction(baseUrl, accessToken, 'workspace-mutation', {
    action: 'list',
  });
  for (const workspace of Array.isArray(listed?.workspaces) ? listed.workspaces : []) {
    if (!workspace?.id) continue;
    await callFunction(baseUrl, accessToken, 'workspace-mutation', {
      action: 'deleteWorkspace',
      workspaceId: workspace.id,
    }).catch(() => {});
  }
}
