import { describe, expect, it, vi } from 'vitest';

import { recordOrganizationAudit, recordWorkspaceAudit, type DbRef } from '../../lib/org-audit';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fakeDb(tables: Record<string, Row[]> = {}) {
  return makeFakeDb(tables) as unknown as DbRef & { tables: Record<string, Row[]> };
}

describe('recordOrganizationAudit', () => {
  it('inserts the audit event as given', async () => {
    const db = fakeDb();
    await recordOrganizationAudit(db, {
      organizationId: 'org1',
      workspaceId: 'ws1',
      actorId: 'u1',
      action: 'page.deleted',
      targetType: 'page',
      targetId: 'p1',
      metadata: { reason: 'cleanup' },
      occurredAt: '2024-05-01T00:00:00.000Z',
    });
    const events = db.tables.organization_audit_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: 'org1',
      workspaceId: 'ws1',
      actorId: 'u1',
      action: 'page.deleted',
      targetType: 'page',
      targetId: 'p1',
      metadata: { reason: 'cleanup' },
      occurredAt: '2024-05-01T00:00:00.000Z',
    });
  });

  it('does not throw on insert failure, logs it, and reports false', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      table: () => ({
        insert: async () => {
          throw new Error('storage down');
        },
        getOne: async () => null,
      }),
    } as unknown as DbRef;
    await expect(
      recordOrganizationAudit(db, { organizationId: 'org1', action: 'x', occurredAt: '2024-01-01T00:00:00.000Z' }),
    ).resolves.toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('organization audit event x');
    spy.mockRestore();
  });

  it('reports true when the insert succeeds', async () => {
    const db = fakeDb();
    await expect(
      recordOrganizationAudit(db, { organizationId: 'org1', action: 'x', occurredAt: '2024-01-01T00:00:00.000Z' }),
    ).resolves.toBe(true);
  });
});

describe('recordWorkspaceAudit', () => {
  it('does nothing without a workspace id', async () => {
    const db = fakeDb();
    await recordWorkspaceAudit(db, { workspaceId: null, action: 'x' });
    await recordWorkspaceAudit(db, { workspaceId: undefined, action: 'x' });
    expect(db.tables.organization_audit_events ?? []).toHaveLength(0);
  });

  it('does nothing when the workspace does not exist', async () => {
    const db = fakeDb();
    await recordWorkspaceAudit(db, { workspaceId: 'missing', action: 'x' });
    expect(db.tables.organization_audit_events ?? []).toHaveLength(0);
  });

  it('does nothing when the workspace has no organization', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: null } as Row] });
    await recordWorkspaceAudit(db, { workspaceId: 'ws1', action: 'x' });
    expect(db.tables.organization_audit_events ?? []).toHaveLength(0);
  });

  it('records an event with the workspace organization and defaults', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: 'org1' } as Row] });
    await recordWorkspaceAudit(db, { workspaceId: 'ws1', action: 'member.invited' });
    const events = db.tables.organization_audit_events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: 'org1',
      workspaceId: 'ws1',
      actorId: null,
      action: 'member.invited',
      targetType: null,
      targetId: null,
      metadata: null,
    });
    expect(events[0].occurredAt).toMatch(ISO_PATTERN);
  });

  it('keeps explicit actor, target, metadata, and timestamp values', async () => {
    const db = fakeDb({ workspaces: [{ id: 'ws1', organizationId: 'org1' } as Row] });
    await recordWorkspaceAudit(db, {
      workspaceId: 'ws1',
      actorId: 'u1',
      action: 'page.trashed',
      targetType: 'page',
      targetId: 'p1',
      metadata: { title: 'Doc' },
      occurredAt: '2024-06-01T12:00:00.000Z',
    });
    expect(db.tables.organization_audit_events[0]).toMatchObject({
      actorId: 'u1',
      targetType: 'page',
      targetId: 'p1',
      metadata: { title: 'Doc' },
      occurredAt: '2024-06-01T12:00:00.000Z',
    });
  });
});
