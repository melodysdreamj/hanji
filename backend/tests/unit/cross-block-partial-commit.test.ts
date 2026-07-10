import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../functions/share-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner-1';

function pageRow(id: string): Row {
  return { id, workspaceId: 'ws1', parentType: 'workspace', createdBy: OWNER, kind: 'page' } as Row;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cross-block partial commits are loudly detectable', () => {
  it('logs [cross-block-partial-commit] when the trailing audit segment fails after the content write', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
      pages: [pageRow('p1')],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const originalTransact = database.transact.bind(database);
    database.transact = async (operations) => {
      // Fail ONLY the central audit segment; the guards and the workspace
      // content segment (page_permissions) commit normally first.
      if (operations.some((op) => op.table === 'organization_audit_events')) {
        throw new Error('simulated central outage');
      }
      return originalTransact(operations);
    };

    const res = await callFunction(POST, database, OWNER, {
      action: 'invite',
      pageId: 'p1',
      email: 'guest.user@example.com',
      role: 'view',
    });

    // The mutation is durable (content segment committed) …
    expect(database.tables.page_permissions).toHaveLength(1);
    // … the audit row was dropped …
    expect(database.tables.organization_audit_events ?? []).toHaveLength(0);
    // … the caller still sees the failure (fail-loud semantics preserved) …
    expect(res).toBeInstanceOf(Response);
    // … and the partial commit is detectable in logs for backfill.
    const partialCommitLog = errorSpy.mock.calls.find(
      (call) => call[0] === '[cross-block-partial-commit]',
    );
    expect(partialCommitLog).toBeDefined();
    const details = JSON.parse(String(partialCommitLog?.[1] ?? '{}')) as Record<string, unknown>;
    expect(details.workspaceId).toBe('ws1');
    expect(details.failedSide).toBe('central');
    expect(details.failedTables).toContain('organization_audit_events');
    expect(details.committedSegments).toBeGreaterThanOrEqual(1);
  });

  it('does not log when the first segment fails (nothing committed, fail-closed)', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
      pages: [pageRow('p1')],
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    expect(
      errorSpy.mock.calls.some((call) => call[0] === '[cross-block-partial-commit]'),
    ).toBe(false);
  });
});
