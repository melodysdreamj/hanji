import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserAuthStorageKeys,
  captureBrowserSession,
  installBrowserSession,
  watchBrowserErrors,
} from './lib/harness.mjs';

test('browser auth storage keys mirror the EdgeBase origin namespace', () => {
  assert.deepEqual(browserAuthStorageKeys('http://127.0.0.1:8787'), {
    prefix: 'edgebase:http%3A%2F%2F127.0.0.1%3A8787',
    refreshTokenKey: 'edgebase:http%3A%2F%2F127.0.0.1%3A8787:refresh-token',
    cookieSessionKey: 'edgebase:http%3A%2F%2F127.0.0.1%3A8787:cookie-session',
  });
  assert.equal(
    browserAuthStorageKeys('https://ignored.example', 'product-a').refreshTokenKey,
    'edgebase:product-a:refresh-token',
  );
});

test('browser smoke sessions migrate once, then move only the HttpOnly cookie between contexts', async () => {
  const session = {
    refreshToken: 'legacy-refresh-secret',
    userId: 'user-1',
    workspaceId: 'workspace-1',
  };
  const first = fakeContext([]);
  await installBrowserSession(first, session, {
    appOrigin: 'http://localhost:3000',
    authOrigin: 'http://127.0.0.1:8787',
    localStorage: { 'hanji.debugPresence': '1' },
  });
  assert.equal(first.addedCookies.length, 0);
  assert.equal(first.initPayload.legacyRefreshToken, 'legacy-refresh-secret');
  assert.equal(first.initPayload.workspaceId, 'workspace-1');
  assert.equal(
    first.initPayload.refreshTokenKey,
    'edgebase:http%3A%2F%2F127.0.0.1%3A8787:refresh-token',
  );
  const storage = new Map();
  runInitScript(first, storage, 'http://localhost:3000');
  assert.equal(
    storage.get('edgebase:http%3A%2F%2F127.0.0.1%3A8787:refresh-token'),
    'legacy-refresh-secret',
  );
  assert.equal(storage.has('edgebase:refresh-token'), false);
  storage.delete('edgebase:http%3A%2F%2F127.0.0.1%3A8787:refresh-token');
  runInitScript(first, storage, 'http://localhost:3000');
  assert.equal(
    storage.has('edgebase:http%3A%2F%2F127.0.0.1%3A8787:refresh-token'),
    false,
  );

  const externalStorage = new Map();
  runInitScript(first, externalStorage, 'https://attacker.example');
  assert.deepEqual(Array.from(externalStorage.entries()), []);

  const authCookie = {
    name: 'hanji-refresh',
    value: 'http-only-secret',
    domain: '127.0.0.1',
    path: '/api/auth',
    expires: -1,
    httpOnly: true,
    secure: false,
    sameSite: 'Strict',
  };
  first.availableCookies = [
    authCookie,
    { ...authCookie, name: 'readable-preference', path: '/', httpOnly: false },
    { ...authCookie, domain: 'attacker.example' },
  ];
  await captureBrowserSession(first, session, {
    appOrigin: 'http://localhost:3000',
    authOrigin: 'http://127.0.0.1:8787',
  });
  assert.deepEqual(session.browserCookies, [authCookie]);
  assert.deepEqual(first.cookieQueries, ['http://127.0.0.1:8787/api/auth/refresh']);

  // An offline-only context has no rotated cookie to capture; the previous
  // hand-off must survive so the next context can continue the session.
  const offlineOnly = fakeContext([]);
  offlineOnly.availableCookies = [];
  await captureBrowserSession(offlineOnly, session, {
    appOrigin: 'http://localhost:3000',
    authOrigin: 'http://127.0.0.1:8787',
  });
  assert.deepEqual(session.browserCookies, [authCookie]);

  const second = fakeContext([]);
  await installBrowserSession(second, session, {
    appOrigin: 'http://localhost:3000',
    authOrigin: 'http://127.0.0.1:8787',
  });
  assert.deepEqual(second.addedCookies, [authCookie]);
  assert.equal(second.initPayload.legacyRefreshToken, '');
  assert.equal(JSON.stringify(second.initPayload).includes('http-only-secret'), false);
  const secondStorage = new Map();
  runInitScript(second, secondStorage, 'http://localhost:3000');
  assert.deepEqual(JSON.parse(
    secondStorage.get('edgebase:http%3A%2F%2F127.0.0.1%3A8787:cookie-session'),
  ), {
    version: 1,
    userId: 'user-1',
  });
});

test('browser diagnostics consume only the observed initial signed-out refresh 401', async () => {
  const page = fakePage();
  const errors = [];
  const watcher = watchBrowserErrors(page, {
    errors,
    allowInitialSignedOutRefresh401: true,
  });
  const generic401 = {
    type: () => 'error',
    text: () => 'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
    location: () => ({}),
  };

  await page.emit('response', fakeResponse(401, 'http://127.0.0.1:8787/api/auth/refresh'));
  await page.emit('console', generic401);
  assert.deepEqual(errors, []);

  await page.emit('response', fakeResponse(401, 'http://127.0.0.1:8787/api/auth/refresh'));
  await page.emit('console', generic401);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /Unexpected repeated 401/);
  assert.equal(errors[1], generic401.text());

  await watcher.endInitialSignedOutRefreshWindow();
  await page.emit('response', fakeResponse(401, 'http://127.0.0.1:8787/api/auth/refresh'));
  await page.emit('console', generic401);
  assert.deepEqual(errors.slice(-1), [generic401.text()]);

  const consoleFirstPage = fakePage();
  const consoleFirstErrors = [];
  const consoleFirstWatcher = watchBrowserErrors(consoleFirstPage, {
    errors: consoleFirstErrors,
    allowInitialSignedOutRefresh401: true,
  });
  await consoleFirstPage.emit('console', generic401);
  await consoleFirstPage.emit(
    'response',
    fakeResponse(401, 'http://127.0.0.1:8787/api/auth/refresh'),
  );
  await consoleFirstWatcher.endInitialSignedOutRefreshWindow();
  assert.deepEqual(consoleFirstErrors, []);

  const wrongLocationPage = fakePage();
  const wrongLocationErrors = [];
  const wrongLocationWatcher = watchBrowserErrors(wrongLocationPage, {
    errors: wrongLocationErrors,
    allowInitialSignedOutRefresh401: true,
  });
  await wrongLocationPage.emit('console', {
    ...generic401,
    location: () => ({ url: 'http://127.0.0.1:8787/api/functions/private' }),
  });
  await wrongLocationPage.emit(
    'response',
    fakeResponse(401, 'http://127.0.0.1:8787/api/auth/refresh'),
  );
  await wrongLocationPage.emit('console', generic401);
  await wrongLocationWatcher.endInitialSignedOutRefreshWindow();
  assert.deepEqual(wrongLocationErrors, [generic401.text()]);
});

test('browser diagnostics can narrowly allow an initial invalid-Origin refresh 400', async () => {
  const page = fakePage();
  const errors = [];
  const watcher = watchBrowserErrors(page, {
    errors,
    allowInitialSignedOutRefreshStatuses: [400, 401],
  });
  const generic400 = {
    type: () => 'error',
    text: () => 'Failed to load resource: the server responded with a status of 400 (Bad Request)',
    location: () => ({ url: 'http://hanji-nonlocal.test:8787/api/auth/refresh' }),
  };

  await page.emit('console', generic400);
  await page.emit('response', fakeResponse(400, 'http://hanji-nonlocal.test:8787/api/auth/refresh'));
  await watcher.endInitialSignedOutRefreshWindow();
  assert.deepEqual(errors, []);

  await page.emit('console', generic400);
  assert.deepEqual(errors, [generic400.text()]);
});

function fakeContext(cookies) {
  return {
    availableCookies: cookies,
    addedCookies: [],
    initScript: null,
    initPayload: null,
    cookieQueries: [],
    async addCookies(values) {
      this.addedCookies.push(...values);
    },
    async addInitScript(script, payload) {
      this.initScript = script;
      this.initPayload = payload;
    },
    async cookies(...urls) {
      this.cookieQueries.push(...urls);
      return this.availableCookies;
    },
  };
}

function runInitScript(context, storage, origin) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    location: { origin },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };
  try {
    context.initScript(context.initPayload);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

function fakePage() {
  const listeners = new Map();
  return {
    on(type, listener) {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    async emit(type, value) {
      await Promise.all((listeners.get(type) ?? []).map((listener) => listener(value)));
    },
  };
}

function fakeResponse(status, url) {
  return {
    status: () => status,
    url: () => url,
    text: async () => '',
  };
}
