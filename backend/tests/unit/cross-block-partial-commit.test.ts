import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../functions/share-mutation';
import { flushOrganizationAuditOutbox } from '../../lib/organization-audit-outbox';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner-1';

function pageRow(id: string): Row {
  return { id, workspaceId: 'ws1', parentType: 'workspace', createdBy: OWNER, kind: 'page' } as Row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('durable organization audit handoff', () => {
  it('returns primary success and preserves an outbox row when the central audit write fails', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
      pages: [pageRow('p1')],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalTable = database.table.bind(database);
    database.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'organization_audit_events') return table;
      return { ...table, insert: async () => { throw new Error('simulated central outage'); } };
    }) as typeof database.table;

    const res = await callFunction(POST, database, OWNER, {
      action: 'invite',
      pageId: 'p1',
      email: 'guest.user@example.com',
      role: 'view',
    });

    // The mutation is durable (content segment committed) …
    expect(database.tables.page_permissions).toHaveLength(1);
    // … the audit row is pending, not dropped …
    expect(database.tables.organization_audit_events ?? []).toHaveLength(0);
    expect(database.tables.organization_audit_outbox).toHaveLength(1);
    // … callers see the content mutation as successful …
    expect(res).not.toBeInstanceOf(Response);
    // … and operators can see the durable retry state.
    expect(warnSpy).toHaveBeenCalledWith(
      '[organization-audit-outbox-pending]',
      expect.stringContaining('simulated central outage'),
    );

    database.table = originalTable as typeof database.table;
    await expect(flushOrganizationAuditOutbox(database, database, 'ws1')).resolves.toMatchObject({
      delivered: [expect.any(String)],
      failures: [],
    });
    expect(database.tables.organization_audit_events).toHaveLength(1);
    expect(database.tables.organization_audit_outbox).toHaveLength(0);
  });

  it('writes no outbox row when the first segment fails (nothing committed)', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
      pages: [pageRow('p1')],
    });
    database.transact = async () => {
      throw new Error('simulated total outage');
    };

    const res = await callFunction(POST, database, OWNER, {
      action: 'invite',
      pageId: 'p1',
      email: 'guest.user@example.com',
      role: 'view',
    });

    expect(res).toBeInstanceOf(Response);
    expect(database.tables.page_permissions ?? []).toHaveLength(0);
    expect(database.tables.organization_audit_outbox ?? []).toHaveLength(0);
  });

  it('does not report a false failure when the post-commit outbox listing is unavailable', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
      pages: [pageRow('p1')],
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const originalTable = database.table.bind(database);
    database.table = ((name: string) => {
      const table = originalTable(name);
      if (name !== 'organization_audit_outbox') return table;
      return {
        ...table,
        where: () => {
          const query = {
            page: () => query,
            limit: () => query,
            where: () => query,
            getList: async () => { throw new Error('simulated outbox read outage'); },
          };
          return query;
        },
      };
    }) as typeof database.table;

    const res = await callFunction(POST, database, OWNER, {
      action: 'invite',
      pageId: 'p1',
      email: 'guest.user@example.com',
      role: 'view',
    });

    expect(res).not.toBeInstanceOf(Response);
    expect(database.tables.page_permissions).toHaveLength(1);
    expect(database.tables.organization_audit_outbox).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[organization-audit-outbox-pending]',
      expect.stringContaining('simulated outbox read outage'),
    );
  });
});
