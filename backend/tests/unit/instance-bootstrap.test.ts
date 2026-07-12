import { describe, expect, it, vi } from 'vitest';
import {
  GET,
  POST,
  isSetupBlocked,
  normalizeMasterEmail,
  planMasterBootstrap,
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
});
