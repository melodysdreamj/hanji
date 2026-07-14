import { describe, expect, it, vi } from 'vitest';
import {
  GET,
  POST,
  isSetupBlocked,
  normalizeMasterEmail,
  planMasterBootstrap,
  setupTokenAuthorized,
  validSetupPassword,
} from '../../functions/instance-bootstrap';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

describe('normalizeMasterEmail', () => {
  it('lowercases and trims a valid address', () => {
    expect(normalizeMasterEmail('  Master@Hanji.LOCAL ')).toBe('master@hanji.local');
  });

  it('rejects invalid or empty values', () => {
    expect(normalizeMasterEmail('not-an-email')).toBeNull();
    expect(normalizeMasterEmail('a@b')).toBeNull();
    expect(normalizeMasterEmail('')).toBeNull();
    expect(normalizeMasterEmail(undefined)).toBeNull();
  });
});

describe('web setup credential guards', () => {
  it('requires a normal strong account password', () => {
    expect(validSetupPassword('Hanji-Setup!2026')).toBe(true);
    expect(validSetupPassword('no-symbol-2026')).toBe(false);
    expect(validSetupPassword('NO-LOWER!2026')).toBe(false);
    expect(validSetupPassword('Short!1a')).toBe(false);
    expect(validSetupPassword('Hanji Setup!2026')).toBe(false);
  });

  it('compares an optional hosted setup token without weakening local setup', () => {
    expect(setupTokenAuthorized(null, undefined)).toBe(true);
    expect(setupTokenAuthorized('private-setup-token', 'private-setup-token')).toBe(true);
    expect(setupTokenAuthorized('private-setup-token', 'wrong-token')).toBe(false);
    expect(setupTokenAuthorized('private-setup-token', undefined)).toBe(false);
  });
});

describe('planMasterBootstrap', () => {
  const base = {
    masterEmail: 'master@example.com',
    masterPassword: 'MasterPass!2026',
    settingsMasterEmail: null as string | null,
    settingsMasterUserId: null as string | null,
  };

  it('is unconfigured without both env values', () => {
    expect(planMasterBootstrap({ ...base, masterEmail: null })).toEqual({
      masterConfigured: false,
      needsEnsure: false,
    });
    expect(planMasterBootstrap({ ...base, masterPassword: null })).toEqual({
      masterConfigured: false,
      needsEnsure: false,
    });
  });

  it('needs ensure on first boot', () => {
    expect(planMasterBootstrap(base)).toEqual({ masterConfigured: true, needsEnsure: true });
  });

  it('skips ensure when settings already record the same master email', () => {
    expect(
      planMasterBootstrap({
        ...base,
        settingsMasterEmail: 'master@example.com',
        settingsMasterUserId: 'user-1',
      }),
    ).toEqual({ masterConfigured: true, needsEnsure: false });
  });

  it('re-runs ensure when the env master email rotates', () => {
    expect(
      planMasterBootstrap({
        ...base,
        masterEmail: 'next-master@example.com',
        settingsMasterEmail: 'master@example.com',
        settingsMasterUserId: 'user-1',
      }),
    ).toEqual({ masterConfigured: true, needsEnsure: true });
  });

  it('re-runs ensure when settings lack the master user id', () => {
    expect(
      planMasterBootstrap({
        ...base,
        settingsMasterEmail: 'master@example.com',
        settingsMasterUserId: null,
      }),
    ).toEqual({ masterConfigured: true, needsEnsure: true });
  });
});

describe('master credential response boundary', () => {
  const email = 'master@example.com';
  const password = 'MasterPass!2026';
  const db = () => fakeDb({
    instance_settings: [{
      id: 'global',
      masterUserId: 'master-user',
      masterEmail: email,
      instanceAdminUserIds: ['master-user'],
    }],
  });

  it('does not advertise the master email or dev auto-login on a spoofable localhost URL', async () => {
    const response = await handlerOf(GET)({
      request: new Request('http://localhost/api/functions/instance-bootstrap'),
      env: {
        HANJI_MASTER_EMAIL: email,
        HANJI_MASTER_PASSWORD: password,
        HANJI_MASTER_DEV_AUTOLOGIN: 'true',
      },
      admin: { db, auth: undefined },
    });
    const payload = await (response as Response).json() as Record<string, unknown>;

    expect(payload.devAutoLoginAvailable).toBe(false);
    expect(payload).not.toHaveProperty('masterEmail');
    expect(JSON.stringify(payload)).not.toContain(password);
  });

  it('always rejects legacy claims without reading credentials into the response', async () => {
    const response = await handlerOf(POST)({
      request: new Request('http://localhost/api/functions/instance-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: 'localhost' },
        body: JSON.stringify({ action: 'claimDevAutoLogin' }),
      }),
      env: {
        HANJI_MASTER_EMAIL: email,
        HANJI_MASTER_PASSWORD: password,
        HANJI_MASTER_DEV_AUTOLOGIN: 'true',
      },
      admin: { db, auth: undefined },
    });
    const payload = await (response as Response).json() as Record<string, unknown>;

    expect((response as Response).status).toBe(403);
    expect(payload.granted).toBe(false);
    expect(payload).not.toHaveProperty('email');
    expect(payload).not.toHaveProperty('password');
    expect(JSON.stringify(payload)).not.toContain(password);
  });

  it('keeps auth/provider exception details out of the unauthenticated status response', async () => {
    const internalDetail = 'postgres://db.internal:5432 auth provider key=secret';
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await handlerOf(GET)({
        request: new Request('https://app.example.com/api/functions/instance-bootstrap'),
        env: {
          HANJI_MASTER_EMAIL: email,
          HANJI_MASTER_PASSWORD: password,
        },
        admin: {
          db: () => fakeDb({ instance_settings: [] }),
          auth: {
            async getUser() { return {}; },
            async listUsers() { throw new Error(internalDetail); },
            async createUser() { return {}; },
          },
        },
      });
      const payload = await (response as Response).json() as Record<string, unknown>;

      expect(payload.masterError).toBe('Master account provisioning failed. Check the server logs.');
      expect(JSON.stringify(payload)).not.toContain(internalDetail);
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('never promotes an unconfirmed ordinary account that pre-claimed the master email', async () => {
    const appDb = fakeDb({ instance_settings: [] });
    const createUser = vi.fn(async () => ({ id: 'must-not-be-created', email }));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await handlerOf(GET)({
        request: new Request('https://app.example.com/api/functions/instance-bootstrap'),
        env: {
          HANJI_MASTER_EMAIL: email,
          HANJI_MASTER_PASSWORD: password,
        },
        admin: {
          db: () => appDb,
          auth: {
            async getUser() { return {}; },
            async listUsers() {
              return { users: [{ id: 'attacker-account', email }] };
            },
            createUser,
          },
        },
      });
      const payload = await (response as Response).json() as Record<string, unknown>;

      expect(payload.masterReady).toBe(false);
      expect(payload.masterError).toBe('Master account provisioning failed. Check the server logs.');
      expect(createUser).not.toHaveBeenCalled();
      await expect(appDb.table('instance_settings').getOne('global')).rejects.toMatchObject({ code: 404 });
    } finally {
      errorLog.mockRestore();
    }
  });

  it('converges after a concurrent trusted bootstrap records the confirmed master id', async () => {
    const appDb = fakeDb({ instance_settings: [] });
    const createUser = vi.fn(async () => {
      throw new Error('unique email conflict from concurrent bootstrap');
    });
    const context = {
      request: new Request('https://app.example.com/api/functions/instance-bootstrap'),
      env: {
        HANJI_MASTER_EMAIL: email,
        HANJI_MASTER_PASSWORD: password,
      },
      admin: {
        db: () => appDb,
        auth: {
          async getUser() { return {}; },
          async listUsers() { return { users: [] }; },
          createUser,
        },
      },
    };

    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const losingResponse = await handlerOf(GET)(context);
      const losingPayload = await (losingResponse as Response).json() as Record<string, unknown>;
      expect(losingPayload.masterReady).toBe(false);
      expect(createUser).toHaveBeenCalledTimes(1);

      await appDb.table('instance_settings').insert({
        id: 'global',
        masterUserId: 'winner-master',
        masterEmail: email,
        instanceAdminUserIds: ['winner-master'],
      });
      const retryResponse = await handlerOf(GET)(context);
      const retryPayload = await (retryResponse as Response).json() as Record<string, unknown>;

      expect(retryPayload.masterReady).toBe(true);
      expect(retryPayload.masterError).toBeNull();
      expect(createUser).toHaveBeenCalledTimes(1);
    } finally {
      errorLog.mockRestore();
    }
  });
});

describe('development guest bootstrap flag', () => {
  async function bootstrapStatus(env: Record<string, unknown>) {
    const response = await handlerOf(GET)({
      request: new Request('http://127.0.0.1/api/functions/instance-bootstrap'),
      env,
      admin: {
        db: () => fakeDb({ instance_settings: [] }),
        auth: {
          async getUser() { return {}; },
          async listUsers() { return { users: [] }; },
          async createUser() { return {}; },
        },
      },
    });
    return await (response as Response).json() as Record<string, unknown>;
  }

  it('ignores the retired alias and accepts only the current explicit dev flag', async () => {
    await expect(bootstrapStatus({
      HANJI_ALLOW_ANONYMOUS_BOOTSTRAP: 'true',
    })).resolves.toMatchObject({ setupBlocked: true });
    await expect(bootstrapStatus({
      HANJI_ALLOW_DEV_GUEST_LOGIN: 'true',
    })).resolves.toMatchObject({ setupBlocked: false });
  });
});

describe('first-run web setup', () => {
  const email = 'owner@example.com';
  const password = 'Hanji-Owner!2026';

  function context(appDb: ReturnType<typeof fakeDb>, users: Array<Record<string, unknown>> = []) {
    return {
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'completeSetup', email, password }),
      }),
      env: { HANJI_BROWSER_SETUP: 'true' },
      admin: {
        db: () => appDb,
        auth: {
          async getUser() { return {}; },
          async listUsers() { return { users }; },
          async createUser(data: Record<string, unknown>) {
            const created = { id: 'setup-master', ...data };
            users.push(created);
            return created;
          },
        },
      },
    };
  }

  it('advertises browser-only setup without requiring a terminal code', async () => {
    const response = await handlerOf(GET)({
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap'),
      env: { HANJI_BROWSER_SETUP: 'true' },
      admin: {
        db: () => fakeDb({ instance_settings: [] }),
        auth: {
          async getUser() { return {}; },
          async listUsers() { return { users: [] }; },
          async createUser() { return {}; },
        },
      },
    });
    const payload = await (response as Response).json() as Record<string, unknown>;

    expect(payload).toMatchObject({
      setupAvailable: true,
      setupCodeRequired: false,
      setupBlocked: false,
      masterConfigured: false,
    });
    expect(payload).not.toHaveProperty('setupCode');
  });

  it('requires the private deploy link token before exposing or claiming hosted setup', async () => {
    const appDb = fakeDb({
      instance_settings: [],
      instance_setup: [],
      instance_audit_events: [],
    });
    const users: Array<Record<string, unknown>> = [];
    const env = {
      HANJI_BROWSER_SETUP: 'true',
      HANJI_BROWSER_SETUP_TOKEN: 'hosted-private-setup-token-2026',
    };
    const auth = {
      async getUser() { return {}; },
      async listUsers() { return { users }; },
      async createUser(data: Record<string, unknown>) {
        const created = { id: 'hosted-setup-master', ...data };
        users.push(created);
        return created;
      },
    };

    const publicStatus = await handlerOf(GET)({
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap'),
      env,
      admin: { db: () => appDb, auth },
    });
    await expect((publicStatus as Response).json()).resolves.toMatchObject({
      setupAvailable: false,
      setupAuthorizationRequired: true,
      setupBlocked: false,
    });

    const unauthorized = await handlerOf(POST)({
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'completeSetup', email, password }),
      }),
      env,
      admin: { db: () => appDb, auth },
    });
    expect((unauthorized as Response).status).toBe(403);
    expect(appDb.tables.instance_setup).toHaveLength(0);
    expect(users).toHaveLength(0);

    const authorizedStatus = await handlerOf(GET)({
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap', {
        headers: { 'X-Hanji-Setup-Token': env.HANJI_BROWSER_SETUP_TOKEN },
      }),
      env,
      admin: { db: () => appDb, auth },
    });
    await expect((authorizedStatus as Response).json()).resolves.toMatchObject({
      setupAvailable: true,
      setupAuthorizationRequired: false,
    });

    const authorized = await handlerOf(POST)({
      request: new Request('https://hanji.example.com/api/functions/instance-bootstrap', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'X-Hanji-Setup-Token': env.HANJI_BROWSER_SETUP_TOKEN,
        },
        body: JSON.stringify({ action: 'completeSetup', email, password }),
      }),
      env,
      admin: { db: () => appDb, auth },
    });
    expect((authorized as Response).status).toBe(201);
    expect(users).toHaveLength(1);
  });

  it('creates exactly one confirmed master and closes setup', async () => {
    const appDb = fakeDb({
      instance_settings: [],
      instance_setup: [],
      instance_audit_events: [],
    });
    const users: Array<Record<string, unknown>> = [];
    const first = await handlerOf(POST)(context(appDb, users));
    const second = await handlerOf(POST)(context(appDb, users));

    expect((first as Response).status).toBe(201);
    expect((second as Response).status).toBe(409);
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ email, displayName: 'Master', role: 'user' });
    expect(appDb.tables.instance_settings[0]).toMatchObject({
      id: 'global',
      masterUserId: 'setup-master',
      masterEmail: email,
      instanceAdminUserIds: ['setup-master'],
    });
    expect(appDb.tables.instance_setup[0]).toMatchObject({
      id: 'global',
      state: 'complete',
      email,
      userId: 'setup-master',
    });
    expect(appDb.tables.instance_audit_events[0]).toMatchObject({
      action: 'instance.master.bootstrap',
      metadata: { createdAccount: true, source: 'web-setup' },
    });
  });

  it('rejects a runtime without browser setup and an already-populated instance', async () => {
    const appDb = fakeDb({ instance_settings: [], instance_setup: [] });
    const disabled = { ...context(appDb), env: {} };
    const disabledResponse = await handlerOf(POST)(disabled);
    expect((disabledResponse as Response).status).toBe(409);
    expect(appDb.tables.instance_setup).toHaveLength(0);

    const occupied = context(appDb, [{ id: 'existing-user', email: 'existing@example.com' }]);
    const occupiedResponse = await handlerOf(POST)(occupied);
    expect((occupiedResponse as Response).status).toBe(409);
    expect(appDb.tables.instance_setup).toHaveLength(0);
  });

  it('never reopens setup when durable settings already record a master', async () => {
    const appDb = fakeDb({
      instance_settings: [{
        id: 'global',
        masterUserId: 'existing-master',
        masterEmail: 'existing@example.com',
        instanceAdminUserIds: ['existing-master'],
      }],
      instance_setup: [],
    });
    const response = await handlerOf(POST)(context(appDb, []));

    expect((response as Response).status).toBe(409);
    expect(appDb.tables.instance_setup).toHaveLength(0);
  });
});

describe('isSetupBlocked', () => {
  it('never blocks when master credentials are configured', () => {
    expect(
      isSetupBlocked({ masterConfigured: true, usersExist: false, devGuestEnabled: false }),
    ).toBe(false);
  });

  it('never blocks an instance that already has users', () => {
    expect(
      isSetupBlocked({ masterConfigured: false, usersExist: true, devGuestEnabled: false }),
    ).toBe(false);
  });

  it('blocks a fresh instance without master credentials', () => {
    expect(
      isSetupBlocked({ masterConfigured: false, usersExist: false, devGuestEnabled: false }),
    ).toBe(true);
  });

  it('keeps the loopback dev-guest escape usable for fresh dev/test runtimes', () => {
    expect(
      isSetupBlocked({ masterConfigured: false, usersExist: false, devGuestEnabled: true }),
    ).toBe(false);
  });

  it('offers first-run web setup instead of the operator-blocked state', () => {
    expect(
      isSetupBlocked({
        masterConfigured: false,
        usersExist: false,
        devGuestEnabled: false,
        setupAvailable: true,
      }),
    ).toBe(false);
  });
});
