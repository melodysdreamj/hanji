import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import {
  browserAuthStorageKeys,
  captureBrowserSession,
  cleanupRegisteredSmokeAccounts,
  deleteSmokeAccounts,
  deleteSmokeUser,
  deleteSmokeUserByEmail,
  deleteSmokeWorkspace,
  installBrowserSession,
  signIn,
  watchBrowserErrors,
} from './lib/harness.mjs';

const LOCAL_ANONYMOUS_SIGNIN_RESIDUALS = [
  '../mcp/scripts/tool-invocation-smoke.mjs',
  './backlinks-visual-smoke.mjs',
  './basic-blocks-visual-smoke.mjs',
  './block-actions-ui-smoke.mjs',
  './block-actions-visual-smoke.mjs',
  './block-drag-ui-smoke.mjs',
  './block-editor-ui-smoke.mjs',
  './block-reorder-ui-smoke.mjs',
  './comment-ui-smoke.mjs',
  './comments-panel-visual-smoke.mjs',
  './database-board-drag-ui-smoke.mjs',
  './database-calendar-drag-ui-smoke.mjs',
  './database-filter-matrix-smoke.mjs',
  './database-imported-view-config-ui-smoke.mjs',
  './database-permission-ui-smoke.mjs',
  './database-property-drag-ui-smoke.mjs',
  './database-property-edit-smoke.mjs',
  './database-property-menu-ui-smoke.mjs',
  './database-property-resize-ui-smoke.mjs',
  './database-property-visual-smoke.mjs',
  './database-relation-smoke.mjs',
  './database-row-drag-ui-smoke.mjs',
  './database-row-peek-smoke.mjs',
  './database-row-peek-visual-smoke.mjs',
  './database-template-smoke.mjs',
  './database-timeline-drag-ui-smoke.mjs',
  './database-toolbar-visual-smoke.mjs',
  './database-view-tabs-visual-smoke.mjs',
  './database-view-ui-smoke.mjs',
  './dialog-visual-smoke.mjs',
  './enterprise-controls-smoke.mjs',
  './file-smoke.mjs',
  './identity-lookup-ui-smoke.mjs',
  './import-export-smoke.mjs',
  './mentions-visual-smoke.mjs',
  './multi-user-permission-smoke.mjs',
  './nested-blocks-visual-smoke.mjs',
  './notification-smoke.mjs',
  './notion-import-live-smoke.mjs',
  './page-chrome-ui-smoke.mjs',
  './page-email-share-ui-smoke.mjs',
  './page-tree-ui-smoke.mjs',
  './populated-page-visual-smoke.mjs',
  './presence-ui-smoke.mjs',
  './public-share-visual-smoke.mjs',
  './search-dialog-visual-smoke.mjs',
  './search-ui-smoke.mjs',
  './share-dialog-visual-smoke.mjs',
  './slash-menu-visual-smoke.mjs',
  './table-render-perf.mjs',
  './templates-dialog-visual-smoke.mjs',
  './updates-ui-smoke.mjs',
  './workspace-membership-smoke.mjs',
  './workspace-switcher-ui-smoke.mjs',
  './workspace-switcher-visual-smoke.mjs',
];

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

test('non-anonymous smoke account creators keep durable finally cleanup guards', () => {
  const files = [
    './admin-provisioning-ui-smoke.mjs',
    './auth-ui-smoke.mjs',
    './file-smoke.mjs',
    './first-workspace-visual-smoke.mjs',
    './inbox-badge-ui-smoke.mjs',
    './inbox-chats-ui-smoke.mjs',
    './mcp-hosted-oauth-smoke.mjs',
    './multi-user-permission-smoke.mjs',
    './page-email-share-ui-smoke.mjs',
    './passkey-ui-smoke.mjs',
    './person-mapping-smoke.mjs',
    './security-settings-ui-smoke.mjs',
    './workspace-membership-smoke.mjs',
    './workspace-settings-visual-smoke.mjs',
    '../mcp/scripts/live-smoke.mjs',
  ];
  for (const path of files) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /finally\s*\{/, `${path} must run cleanup from finally`);
    assert.match(
      source,
      /deleteSmokeAccounts|deleteSmokeWorkspace/,
      `${path} must delete owned synthetic workspaces`,
    );
    assert.match(
      source,
      /deleteSmokeAccounts|deleteSmokeUser(?:ByEmail)?/,
      `${path} must delete synthetic accounts by stable id`,
    );
  }
});

test('shared anonymous sign-in users explicitly finalize the current-process registry', () => {
  const users = [];
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (!name.endsWith('-smoke.mjs')) continue;
    const path = `./${name}`;
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    const harnessImport = source.match(
      /import\s*\{([^}]*)\}\s*from\s*['"]\.\/lib\/harness\.mjs['"];/,
    );
    const imported = (harnessImport?.[1] ?? '')
      .split(',')
      .map((entry) => entry.trim().split(/\s+as\s+/)[0]);
    if (!imported.includes('signIn')) continue;
    users.push(path);
    assert(imported.includes('finalizeRegisteredSmokeAccounts'), `${path} must import the registry finalizer`);
    assert.match(source, /finally\s*\{[\s\S]*finalizeRegisteredSmokeAccounts\s*\(/, `${path} must finalize from top-level finally`);
  }
  assert.equal(users.length, 19, `unexpected shared anonymous sign-in inventory: ${JSON.stringify(users)}`);
});

test('local anonymous sign-in copies cannot grow outside the audited residual list', () => {
  const discovered = [];
  for (const name of readdirSync(new URL('.', import.meta.url))) {
    if (!name.endsWith('.mjs') || name.endsWith('.test.mjs')) continue;
    const path = `./${name}`;
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    if (source.includes('/api/auth/signin/anonymous')) discovered.push(path);
  }
  const mcpPath = '../mcp/scripts/tool-invocation-smoke.mjs';
  if (readFileSync(new URL(mcpPath, import.meta.url), 'utf8').includes('/api/auth/signin/anonymous')) {
    discovered.push(mcpPath);
  }
  assert.deepEqual(discovered.sort(), [...LOCAL_ANONYMOUS_SIGNIN_RESIDUALS].sort());
});

test('shared anonymous sign-in cleanup targets only accounts registered by this process', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    accessToken: 'anonymous-token',
    refreshToken: 'anonymous-refresh',
    user: { id: 'anonymous-user-1' },
  }), { status: 201, headers: { 'content-type': 'application/json' } });
  try {
    await signIn('http://127.0.0.1:8787');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const calls = [];
  const result = await cleanupRegisteredSmokeAccounts({
    signInAdmin: async (baseUrl) => {
      assert.equal(baseUrl, 'http://127.0.0.1:8787');
      return 'admin-token';
    },
    call: async (_baseUrl, token, name, body) => {
      calls.push({ token, name, body });
      if (name === 'workspace-mutation' && body.action === 'list') {
        return {
          workspaces: [
            { id: 'owned', name: 'Anonymous smoke workspace', ownerId: 'anonymous-user-1' },
            { id: 'shared', name: 'Preserved workspace', ownerId: 'preexisting-user' },
          ],
        };
      }
      if (name === 'page-query') return { pages: [] };
      return {};
    },
  });
  assert.deepEqual(result, { deletedUserIds: ['anonymous-user-1'], remainingUserIds: [] });
  assert.equal(calls.some((call) => call.body.workspaceId === 'shared'), false);
  assert.deepEqual(calls.filter((call) => call.name === 'instance-admin'), [{
    token: 'admin-token',
    name: 'instance-admin',
    body: { action: 'deleteUser', userId: 'anonymous-user-1' },
  }]);

  const empty = await cleanupRegisteredSmokeAccounts({
    signInAdmin: async () => { throw new Error('must not sign in with an empty registry'); },
  });
  assert.deepEqual(empty, { deletedUserIds: [], remainingUserIds: [] });
});

test('shared anonymous registry survives a cleanup credential failure for an explicit retry', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    accessToken: 'anonymous-token-2',
    refreshToken: 'anonymous-refresh-2',
    user: { id: 'anonymous-user-2' },
  }), { status: 201, headers: { 'content-type': 'application/json' } });
  try {
    await signIn('http://127.0.0.1:8787');
  } finally {
    globalThis.fetch = originalFetch;
  }

  await assert.rejects(
    cleanupRegisteredSmokeAccounts({
      signInAdmin: async () => { throw new Error('admin unavailable'); },
    }),
    /Registered anonymous smoke accounts were not fully cleaned up/,
  );
  const retried = await cleanupRegisteredSmokeAccounts({
    signInAdmin: async () => 'admin-token',
    call: async (_baseUrl, _token, name, body) => {
      if (name === 'workspace-mutation' && body.action === 'list') return { workspaces: [] };
      assert.equal(body.userId, 'anonymous-user-2');
      return {};
    },
  });
  assert.deepEqual(retried, { deletedUserIds: ['anonymous-user-2'], remainingUserIds: [] });
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

  const locatedConsoleOnlyPage = fakePage();
  const locatedConsoleOnlyErrors = [];
  const locatedConsoleOnlyWatcher = watchBrowserErrors(locatedConsoleOnlyPage, {
    errors: locatedConsoleOnlyErrors,
    allowInitialSignedOutRefresh401: true,
  });
  const locatedRefresh401 = {
    ...generic401,
    location: () => ({ url: 'http://127.0.0.1:8787/api/auth/refresh' }),
  };
  await locatedConsoleOnlyPage.emit('console', locatedRefresh401);
  await locatedConsoleOnlyWatcher.endInitialSignedOutRefreshWindow();
  assert.deepEqual(locatedConsoleOnlyErrors, []);
  await locatedConsoleOnlyPage.emit('console', locatedRefresh401);
  assert.deepEqual(locatedConsoleOnlyErrors, [locatedRefresh401.text()]);

  const unlocatedConsoleOnlyPage = fakePage();
  const unlocatedConsoleOnlyErrors = [];
  const unlocatedConsoleOnlyWatcher = watchBrowserErrors(unlocatedConsoleOnlyPage, {
    errors: unlocatedConsoleOnlyErrors,
    allowInitialSignedOutRefresh401: true,
  });
  await unlocatedConsoleOnlyPage.emit('console', generic401);
  await unlocatedConsoleOnlyWatcher.endInitialSignedOutRefreshWindow();
  assert.deepEqual(unlocatedConsoleOnlyErrors, [generic401.text()]);

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

test('smoke cleanup deletes non-empty workspaces with an exact-name confirmation', async () => {
  const calls = [];
  let pageListCalls = 0;
  const result = await deleteSmokeWorkspace(
    'http://127.0.0.1:8787',
    'owner-token',
    { id: 'workspace-1', name: 'Synthetic workspace' },
    {
      call: async (...args) => {
        calls.push(args);
        if (args[2] === 'page-query') {
          pageListCalls += 1;
          return pageListCalls === 1
            ? { pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentType: 'workspace', parentId: null }] }
            : { pages: [] };
        }
        return { deletedId: 'workspace-1' };
      },
      timeoutMs: 1234,
    },
  );
  assert.deepEqual(result, { deletedId: 'workspace-1' });
  assert.deepEqual(calls.map((call) => [call[2], call[3]]), [
    ['page-query', { action: 'pages', workspaceId: 'workspace-1', includeTrash: true }],
    ['page-mutation', { action: 'trash', id: 'page-1' }],
    ['page-mutation', { action: 'delete', id: 'page-1' }],
    ['page-query', { action: 'pages', workspaceId: 'workspace-1', includeTrash: true }],
    ['workspace-mutation', {
      action: 'deleteWorkspace',
      workspaceId: 'workspace-1',
      confirmWorkspaceName: 'Synthetic workspace',
    }],
  ]);
  assert(calls.every((call) => call[4]?.timeoutMs === 1234));
});

test('smoke workspace cleanup tolerates an already-running page deletion', async () => {
  let pageListCalls = 0;
  const calls = [];
  await deleteSmokeWorkspace(
    'http://127.0.0.1:8787',
    'owner-token',
    { id: 'workspace-1', name: 'Synthetic workspace' },
    {
      call: async (_baseUrl, _token, name, body) => {
        calls.push([name, body]);
        if (name === 'page-query') {
          pageListCalls += 1;
          return pageListCalls === 1
            ? { pages: [{ id: 'page-1', workspaceId: 'workspace-1', parentType: 'workspace' }] }
            : { pages: [] };
        }
        if (name === 'page-mutation' && body.action === 'trash') {
          throw new Error('page-mutation returned HTTP 409: Target deletion is already in progress.');
        }
        return {};
      },
    },
  );
  assert.deepEqual(calls.at(-1), [
    'workspace-mutation',
    { action: 'deleteWorkspace', workspaceId: 'workspace-1', confirmWorkspaceName: 'Synthetic workspace' },
  ]);
});

test('smoke cleanup deletes synthetic users only by their stable id', async () => {
  const calls = [];
  await deleteSmokeUser('http://127.0.0.1:8787', 'admin-token', 'user-1', {
    call: async (...args) => {
      calls.push(args);
      return { users: [] };
    },
  });
  assert.deepEqual(calls, [[
    'http://127.0.0.1:8787',
    'admin-token',
    'instance-admin',
    { action: 'deleteUser', userId: 'user-1' },
    {},
  ]]);
});

test('smoke cleanup resolves an exact synthetic email before deleting the stable user id', async () => {
  const calls = [];
  const result = await deleteSmokeUserByEmail(
    'http://127.0.0.1:8787',
    'admin-token',
    'auth-smoke@example.com',
    {
      call: async (...args) => {
        calls.push(args);
        const body = args[3];
        if (body.action === 'searchUsers') {
          return {
            users: [
              { id: 'wrong', email: 'auth-smoke-extra@example.com' },
              { id: 'user-2', email: 'AUTH-SMOKE@example.com' },
            ],
          };
        }
        return { users: [] };
      },
      timeoutMs: 1234,
    },
  );
  assert.deepEqual(result, { deleted: true, userId: 'user-2' });
  assert.deepEqual(calls, [
    [
      'http://127.0.0.1:8787',
      'admin-token',
      'instance-admin',
      { action: 'searchUsers', query: 'auth-smoke@example.com', limit: 10 },
      { timeoutMs: 1234 },
    ],
    [
      'http://127.0.0.1:8787',
      'admin-token',
      'instance-admin',
      { action: 'deleteUser', userId: 'user-2' },
      { timeoutMs: 1234 },
    ],
  ]);
});

test('smoke account cleanup deletes only owned workspaces before stable-id accounts', async () => {
  const calls = [];
  const result = await deleteSmokeAccounts(
    'http://127.0.0.1:8787',
    'admin-token',
    [{ token: 'user-token', userId: 'user-1' }],
    {
      call: async (baseUrl, token, name, body) => {
        calls.push({ token, name, body });
        if (name === 'workspace-mutation' && body.action === 'list') {
          return {
            workspaces: [
              { id: 'owned-1', name: 'Owned', ownerId: 'user-1' },
              { id: 'shared-1', name: 'Shared', ownerId: 'someone-else' },
            ],
          };
        }
        if (name === 'page-query') return { pages: [] };
        return {};
      },
    },
  );
  assert.deepEqual(result, { deletedUserIds: ['user-1'] });
  assert.equal(calls.some((call) => call.body.workspaceId === 'shared-1'), false);
  assert.deepEqual(
    calls.filter((call) => call.name === 'workspace-mutation').map((call) => call.body),
    [
      { action: 'list' },
      { action: 'deleteWorkspace', workspaceId: 'owned-1', confirmWorkspaceName: 'Owned' },
    ],
  );
  assert.deepEqual(calls.at(-1), {
    token: 'admin-token',
    name: 'instance-admin',
    body: { action: 'deleteUser', userId: 'user-1' },
  });
});

test('smoke account cleanup keeps workspace and account deletion attempts independent', async () => {
  const deletedWorkspaceIds = [];
  const deletedUserIds = [];
  await assert.rejects(
    deleteSmokeAccounts(
      'http://127.0.0.1:8787',
      'admin-token',
      [{ token: 'user-token', userId: 'user-1' }],
      {
        call: async (_baseUrl, _token, name, body) => {
          if (name === 'workspace-mutation' && body.action === 'list') {
            return {
              workspaces: [
                { id: 'owned-1', name: 'First', ownerId: 'user-1' },
                { id: 'owned-2', name: 'Second', ownerId: 'user-1' },
              ],
            };
          }
          if (name === 'page-query') return { pages: [] };
          if (name === 'workspace-mutation' && body.action === 'deleteWorkspace') {
            deletedWorkspaceIds.push(body.workspaceId);
            if (body.workspaceId === 'owned-1') throw new Error('first workspace delete failed');
          }
          if (name === 'instance-admin' && body.action === 'deleteUser') {
            deletedUserIds.push(body.userId);
          }
          return {};
        },
      },
    ),
    /Smoke accounts were not fully cleaned up/,
  );
  assert.deepEqual(deletedWorkspaceIds, ['owned-1', 'owned-2']);
  assert.deepEqual(deletedUserIds, ['user-1']);
});

test('smoke cleanup leaves accounts alone when no exact synthetic email exists', async () => {
  const calls = [];
  const result = await deleteSmokeUserByEmail(
    'http://127.0.0.1:8787',
    'admin-token',
    'missing@example.com',
    {
      call: async (...args) => {
        calls.push(args);
        return { users: [{ id: 'nearby', email: 'missing-extra@example.com' }] };
      },
    },
  );
  assert.deepEqual(result, { deleted: false });
  assert.equal(calls.length, 1);
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
