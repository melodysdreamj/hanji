import { describe, expect, it } from 'vitest';

import { GET, POST } from '../../functions/account-state';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

function context(
  db: ReturnType<typeof fakeDb>,
  body: Record<string, unknown> = { action: 'get' },
  auth: { id: string; isAnonymous?: boolean } | null = { id: 'user-1' },
) {
  return {
    auth,
    admin: { db: () => db },
    request: new Request('http://localhost:8787/api/functions/account-state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  };
}

async function payload(response: unknown) {
  expect(response).toBeInstanceOf(Response);
  return (response as Response).json() as Promise<Record<string, unknown>>;
}

describe('account language state', () => {
  it('reports an unconfigured authenticated account without inventing a preference', async () => {
    const db = fakeDb({ account_flags: [] });
    const response = await handlerOf(GET)(context(db));

    expect(await payload(response)).toMatchObject({
      ok: true,
      mustChangePassword: false,
      languagePreference: null,
      languageOnboardingCompleted: false,
    });
  });

  it('persists every released language form and preserves existing password flags', async () => {
    const db = fakeDb({
      account_flags: [{
        id: 'user-1',
        mustChangePassword: true,
        reason: 'temporary_password',
      }],
    });

    for (const languagePreference of ['zh-Hans', 'zh-Hant', 'fil', 'ar', 'system']) {
      const response = await handlerOf(POST)(context(db, {
        action: 'setLanguagePreference',
        languagePreference,
      }));
      expect(await payload(response)).toMatchObject({
        ok: true,
        mustChangePassword: true,
        languagePreference,
        languageOnboardingCompleted: true,
      });
    }

    expect(db.tables.account_flags).toHaveLength(1);
    expect(db.tables.account_flags[0]).toMatchObject({
      id: 'user-1',
      mustChangePassword: true,
      languagePreference: 'system',
      languageOnboardingCompleted: true,
      updatedBy: 'user-1',
    });
    expect(typeof db.tables.account_flags[0]?.languageUpdatedAt).toBe('string');
  });

  it('creates a durable row for a first-time account', async () => {
    const db = fakeDb({ account_flags: [] });
    const response = await handlerOf(POST)(context(db, {
      action: 'setLanguagePreference',
      languagePreference: 'ko',
    }));

    expect(await payload(response)).toMatchObject({
      languagePreference: 'ko',
      languageOnboardingCompleted: true,
    });
    expect(db.tables.account_flags[0]).toMatchObject({
      id: 'user-1',
      languagePreference: 'ko',
      languageOnboardingCompleted: true,
    });
  });

  it('rejects unsupported values and anonymous-session persistence', async () => {
    const db = fakeDb({ account_flags: [] });
    const unsupported = await handlerOf(POST)(context(db, {
      action: 'setLanguagePreference',
      languagePreference: 'xx-Unknown',
    }));
    const anonymous = await handlerOf(POST)(context(
      db,
      { action: 'setLanguagePreference', languagePreference: 'en' },
      { id: 'guest-1', isAnonymous: true },
    ));

    expect((unsupported as Response).status).toBe(400);
    expect((anonymous as Response).status).toBe(403);
    expect(db.tables.account_flags).toEqual([]);
  });

  it('requires authentication', async () => {
    const response = await handlerOf(POST)(context(
      fakeDb({ account_flags: [] }),
      { action: 'get' },
      null,
    ));
    expect((response as Response).status).toBe(401);
  });
});
