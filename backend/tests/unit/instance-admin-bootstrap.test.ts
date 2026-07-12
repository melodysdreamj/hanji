import { describe, expect, it } from 'vitest';

import { POST, instanceAdminAuthority } from '../../functions/instance-admin';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const NONE = {
  actorId: 'workspace-owner',
  configuredAdminIds: [],
  envAdminIds: [],
};

describe('instanceAdminAuthority', () => {
  it('does not turn the first ordinary workspace owner into an instance admin', () => {
    expect(instanceAdminAuthority(NONE)).toBeNull();
  });

  it('recognizes an administrator already stored in instance settings', () => {
    expect(instanceAdminAuthority({ ...NONE, configuredAdminIds: ['workspace-owner'] })).toBe('configured');
  });

  it('allows explicit environment bootstrap by user id', () => {
    expect(instanceAdminAuthority({ ...NONE, envAdminIds: ['workspace-owner'] })).toBe('environment');
  });

  it('never treats a caller-claimed email as instance-admin authority', () => {
    expect(instanceAdminAuthority(NONE)).toBeNull();
  });

  it('does not let an allowlist entry for another actor open first-user bootstrap', () => {
    expect(instanceAdminAuthority({
      ...NONE,
      envAdminIds: ['different-user'],
    })).toBeNull();
  });

  it('ignores a matching legacy email allowlist instead of self-promoting the actor', async () => {
    const database = fakeDb({
      instance_settings: [{ id: 'global', instanceAdminUserIds: [] }],
    });
    const result = await handlerOf(POST)({
      auth: { id: 'email-claimer', email: 'admin@example.com' },
      admin: { db: () => database, auth: {} },
      env: { HANJI_INSTANCE_ADMIN_EMAILS: 'admin@example.com' },
      request: new Request('https://app.example.com/functions/instance-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get' }),
      }),
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const settings = await database.table<Record<string, unknown>>('instance_settings').getOne('global');
    expect(settings.instanceAdminUserIds).toEqual([]);
  });

  it('fails closed for a real workspace owner when no bootstrap allowlist exists', async () => {
    const database = fakeDb({
      instance_settings: [{ id: 'global', instanceAdminUserIds: [] }],
      workspaces: [{ id: 'ws-1', ownerId: 'workspace-owner' }],
      workspace_members: [{
        id: 'member-owner',
        workspaceId: 'ws-1',
        userId: 'workspace-owner',
        role: 'owner',
      }],
    });
    const result = await handlerOf(POST)({
      auth: { id: 'workspace-owner', email: 'owner@example.com' },
      admin: { db: () => database, auth: {} },
      env: {},
      request: new Request('http://localhost/functions/instance-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get' }),
      }),
    });

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('HANJI_INSTANCE_ADMIN_USER_IDS'),
    });
  });

  it('treats exact off as an empty instance-admin allowlist', async () => {
    const database = fakeDb({
      instance_settings: [{ id: 'global', instanceAdminUserIds: [] }],
    });
    const result = await handlerOf(POST)({
      auth: { id: 'off', email: 'synthetic@example.com' },
      admin: { db: () => database, auth: {} },
      env: {
        HANJI_INSTANCE_ADMIN_USER_IDS: 'off',
        EDGEBASE_INSTANCE_ADMIN_USER_IDS: 'off',
      },
      request: new Request('https://app.example.com/functions/instance-admin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'get' }),
      }),
    });

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    const settings = await database.table<Record<string, unknown>>('instance_settings').getOne('global');
    expect(settings.instanceAdminUserIds).toEqual([]);
  });
});
