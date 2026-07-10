import { describe, expect, it } from 'vitest';

import { POST, instanceAdminAuthority } from '../../functions/instance-admin';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

const NONE = {
  actorId: 'workspace-owner',
  actorEmail: 'owner@example.com',
  configuredAdminIds: [],
  envAdminIds: [],
  envAdminEmails: [],
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

  it('allows explicit environment bootstrap by normalized email', () => {
    expect(instanceAdminAuthority({ ...NONE, envAdminEmails: [' OWNER@EXAMPLE.COM '] })).toBe('environment');
  });

  it('does not let an allowlist entry for another actor open first-user bootstrap', () => {
    expect(instanceAdminAuthority({
      ...NONE,
      envAdminIds: ['different-user'],
      envAdminEmails: ['different@example.com'],
    })).toBeNull();
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
      error: expect.stringContaining('NOTIONLIKE_INSTANCE_ADMIN_EMAILS'),
    });
  });
});
