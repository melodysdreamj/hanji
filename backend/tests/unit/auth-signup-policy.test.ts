import { describe, expect, it, vi } from 'vitest';

import signupPolicy from '../../functions/auth-signup-policy';
import { GET as instanceBootstrap } from '../../functions/instance-bootstrap';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const MASTER_EMAIL = 'master@example.com';
const MASTER_PASSWORD = 'MasterPass!2026';
const ENV = {
  HANJI_MASTER_EMAIL: MASTER_EMAIL,
  HANJI_MASTER_PASSWORD: MASTER_PASSWORD,
};

function signupContext(appDb: ReturnType<typeof fakeDb>) {
  return {
    data: { after: { email: 'new-user@example.com' } },
    env: ENV,
    admin: { db: () => appDb },
  };
}

describe('master provisioning signup fence', () => {
  it('retires the anonymous-bootstrap alias while preserving the explicit local dev flag', async () => {
    const appDb = fakeDb({ instance_settings: [] });
    const baseContext = {
      data: { after: { email: 'new-user@example.com' } },
      admin: {
        db: () => appDb,
        auth: { async listUsers() { return { users: [] }; } },
      },
    };

    await expect(handlerOf(signupPolicy)({
      ...baseContext,
      env: { HANJI_ALLOW_ANONYMOUS_BOOTSTRAP: 'true' },
    })).rejects.toThrow('Instance is not initialized');
    await expect(handlerOf(signupPolicy)({
      ...baseContext,
      env: { HANJI_ALLOW_DEV_GUEST_LOGIN: 'true' },
    })).resolves.toBeUndefined();
  });

  it('blocks every client signup until the configured master identity is confirmed', async () => {
    const appDb = fakeDb({ instance_settings: [] });

    await expect(handlerOf(signupPolicy)(signupContext(appDb))).rejects.toThrow(
      'Master account provisioning must complete before signup',
    );
  });

  it('keeps trusted admin.createUser bootstrap available, then opens signup after confirmation', async () => {
    const appDb = fakeDb({ instance_settings: [], instance_audit_events: [] });
    const createUser = vi.fn(async () => ({ id: 'trusted-master', email: MASTER_EMAIL }));

    await expect(handlerOf(signupPolicy)(signupContext(appDb))).rejects.toThrow(
      'Master account provisioning must complete before signup',
    );

    const response = await handlerOf(instanceBootstrap)({
      request: new Request('https://app.example.com/api/functions/instance-bootstrap'),
      env: ENV,
      admin: {
        db: () => appDb,
        auth: {
          async getUser() { return {}; },
          async listUsers() { return { users: [] }; },
          createUser,
        },
      },
    });
    const payload = await (response as Response).json() as Record<string, unknown>;

    expect(payload.masterReady).toBe(true);
    expect(createUser).toHaveBeenCalledWith({
      email: MASTER_EMAIL,
      password: MASTER_PASSWORD,
      displayName: 'Master',
      role: 'user',
    });
    await expect(handlerOf(signupPolicy)(signupContext(appDb))).resolves.toBeUndefined();
  });

  it('blocks signup again while the configured master email is being rotated', async () => {
    const appDb = fakeDb({
      instance_settings: [{
        id: 'global',
        masterUserId: 'old-master',
        masterEmail: 'old-master@example.com',
        signupPolicy: 'public',
      }],
    });

    await expect(handlerOf(signupPolicy)(signupContext(appDb))).rejects.toThrow(
      'Master account provisioning must complete before signup',
    );
  });
});

describe('server-level signup policy', () => {
  // Master identity confirmed so the initialization fence passes; only the
  // public/closed policy decides whether self-service signup is allowed.
  function confirmedMasterDb(signup: 'public' | 'closed') {
    return fakeDb({
      instance_settings: [{
        id: 'global',
        masterUserId: 'trusted-master',
        masterEmail: MASTER_EMAIL,
        signupPolicy: signup,
      }],
    });
  }

  it('allows self-service signup under the public policy', async () => {
    await expect(handlerOf(signupPolicy)(signupContext(confirmedMasterDb('public')))).resolves.toBeUndefined();
  });

  it('rejects self-service signup under the closed policy', async () => {
    await expect(handlerOf(signupPolicy)(signupContext(confirmedMasterDb('closed')))).rejects.toThrow(
      'Self-service signup is disabled',
    );
  });

  it('treats a legacy invite_only policy as closed', async () => {
    await expect(handlerOf(signupPolicy)(signupContext(confirmedMasterDb('invite_only' as 'closed')))).rejects.toThrow(
      'Self-service signup is disabled',
    );
  });
});
