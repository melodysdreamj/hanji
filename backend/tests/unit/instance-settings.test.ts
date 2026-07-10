import { describe, expect, it } from 'vitest';

import {
  getInstanceSettings,
  INSTANCE_SETTINGS_ID,
  parseSignupPolicy,
  signupPolicyLabels,
  upsertInstanceSettings,
  type DbRef,
  type InstanceSettings,
} from '../../lib/instance-settings';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as DbRef & { tables: Record<string, Row[]> };
}

describe('parseSignupPolicy', () => {
  it('accepts the three known policies', () => {
    expect(parseSignupPolicy('public')).toBe('public');
    expect(parseSignupPolicy('invite_only')).toBe('invite_only');
    expect(parseSignupPolicy('verified_domains')).toBe('verified_domains');
  });

  it('trims and lowercases before matching', () => {
    expect(parseSignupPolicy('  INVITE_ONLY  ')).toBe('invite_only');
  });

  it('falls back for non-string values', () => {
    expect(parseSignupPolicy(undefined)).toBe('public');
    expect(parseSignupPolicy(null, 'invite_only')).toBe('invite_only');
    expect(parseSignupPolicy(42)).toBe('public');
  });

  it('throws for unrecognized strings', () => {
    expect(() => parseSignupPolicy('open')).toThrow('Signup policy is invalid.');
    expect(() => parseSignupPolicy('')).toThrow('Signup policy is invalid.');
  });
});

describe('signupPolicyLabels', () => {
  it('has a label for every policy', () => {
    expect(signupPolicyLabels.public).toBe('anyone');
    expect(signupPolicyLabels.invite_only).toBe('invited users');
    expect(signupPolicyLabels.verified_domains).toBe('verified domains or invitations');
  });
});

describe('getInstanceSettings', () => {
  it('returns defaults when no settings row exists', async () => {
    const settings = await getInstanceSettings(fakeDb());
    expect(settings).toEqual({
      id: INSTANCE_SETTINGS_ID,
      signupPolicy: 'public',
      instanceAdminUserIds: [],
      updatedBy: null,
      createdAt: undefined,
      updatedAt: undefined,
    });
  });

  it('normalizes an existing settings row', async () => {
    const db = fakeDb({
      instance_settings: [{
        id: 'global',
        signupPolicy: 'invite_only',
        updatedBy: 'admin1',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
      } as Row],
    });
    expect(await getInstanceSettings(db)).toEqual({
      id: 'global',
      signupPolicy: 'invite_only',
      instanceAdminUserIds: [],
      updatedBy: 'admin1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    });
  });

  it('normalizes instance admin user ids', async () => {
    const db = fakeDb({
      instance_settings: [{
        id: 'global',
        signupPolicy: 'public',
        instanceAdminUserIds: [' admin1 ', 'admin1', '', 42, 'admin2'],
      } as Row],
    });
    expect((await getInstanceSettings(db)).instanceAdminUserIds).toEqual(['admin1', 'admin2']);
  });

  it('falls back only the invalid stored policy, keeping the rest of the row', async () => {
    const db = fakeDb({
      instance_settings: [{ id: 'global', signupPolicy: 'bogus', updatedBy: 'admin1' } as Row],
    });
    const settings = await getInstanceSettings(db);
    expect(settings.signupPolicy).toBe('public');
    expect(settings.updatedBy).toBe('admin1');
  });
});

describe('upsertInstanceSettings', () => {
  it('updates the existing global row', async () => {
    const db = fakeDb({
      instance_settings: [{ id: 'global', signupPolicy: 'public', updatedBy: null } as Row],
    });
    const settings = await upsertInstanceSettings(db, { signupPolicy: 'verified_domains', updatedBy: 'admin1' });
    expect(settings.signupPolicy).toBe('verified_domains');
    expect(settings.updatedBy).toBe('admin1');
    expect(db.tables.instance_settings).toHaveLength(1);
    expect(db.tables.instance_settings[0].signupPolicy).toBe('verified_domains');
  });

  it('inserts the global row when none exists', async () => {
    const db = fakeDb();
    const settings = await upsertInstanceSettings(db, { signupPolicy: 'invite_only' });
    expect(settings.id).toBe(INSTANCE_SETTINGS_ID);
    expect(settings.signupPolicy).toBe('invite_only');
    expect(db.tables.instance_settings).toHaveLength(1);
    expect(db.tables.instance_settings[0].id).toBe('global');
  });

  it('rejects invalid policies before touching the table', async () => {
    const db = fakeDb();
    await expect(upsertInstanceSettings(db, { signupPolicy: 'anything-goes' })).rejects.toThrow(
      'Signup policy is invalid.',
    );
    expect(db.tables.instance_settings ?? []).toHaveLength(0);
  });

  it('preserves a stricter stored policy when the patch omits signupPolicy', async () => {
    const db = fakeDb({
      instance_settings: [{ id: 'global', signupPolicy: 'invite_only' } as Row],
    });
    const settings = await upsertInstanceSettings(db, { updatedBy: 'admin1' });
    expect(settings.signupPolicy).toBe('invite_only');
    expect(settings.updatedBy).toBe('admin1');
    expect(db.tables.instance_settings[0].signupPolicy).toBe('invite_only');
  });

  it('stores normalized instance admin user ids without changing signupPolicy', async () => {
    const db = fakeDb({
      instance_settings: [{ id: 'global', signupPolicy: 'invite_only' } as Row],
    });
    const settings = await upsertInstanceSettings(db, {
      instanceAdminUserIds: ['admin1', ' admin1 ', 'admin2'],
      updatedBy: 'admin1',
    });
    expect(settings.signupPolicy).toBe('invite_only');
    expect(settings.instanceAdminUserIds).toEqual(['admin1', 'admin2']);
    expect(db.tables.instance_settings[0].instanceAdminUserIds).toEqual(['admin1', 'admin2']);
  });

  it('retries the update when a concurrent insert wins the race', async () => {
    let updateCalls = 0;
    const row: InstanceSettings = { id: 'global', signupPolicy: 'public' };
    const db = {
      table: () => ({
        getOne: async () => row,
        insert: async () => {
          throw new Error('duplicate key');
        },
        update: async (_id: string, patch: Partial<InstanceSettings>) => {
          updateCalls += 1;
          // First update: the row is genuinely absent (404-shaped) so the
          // insert path runs; the concurrent insert then loses, and the final
          // update succeeds.
          if (updateCalls === 1) throw Object.assign(new Error('Record global not found.'), { code: 404 });
          Object.assign(row, patch);
          return row;
        },
      }),
    } as unknown as DbRef;
    const settings = await upsertInstanceSettings(db, { signupPolicy: 'verified_domains' });
    expect(updateCalls).toBe(2);
    expect(settings.signupPolicy).toBe('verified_domains');
  });

  it('propagates a non-not-found update error instead of masking it with an insert', async () => {
    let insertCalled = false;
    const db = {
      table: () => ({
        getOne: async () => ({ id: 'global', signupPolicy: 'public' }),
        insert: async () => {
          insertCalled = true;
          throw new Error('insert should not run');
        },
        update: async () => {
          throw new Error('database is unavailable');
        },
      }),
    } as unknown as DbRef;
    await expect(upsertInstanceSettings(db, { signupPolicy: 'verified_domains' })).rejects.toThrow(
      'database is unavailable',
    );
    expect(insertCalled).toBe(false);
  });
});
