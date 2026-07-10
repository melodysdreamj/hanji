import { describe, expect, it } from 'vitest';
import { POST, pagePermissionRecordId } from '../../functions/share-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const OWNER = 'owner-1';
const STRANGER = 'stranger-1';

function pageRow(id: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    workspaceId: 'ws1',
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Page ${id}`,
    position: 0,
    inTrash: false,
    isPublic: false,
    createdBy: OWNER,
    ...extra,
  };
}

function db(tables: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
    pages: [pageRow('p1')],
    ...tables,
  });
}

describe('share-mutation POST', () => {
  it('requires authentication for non-public actions', async () => {
    const res = await callFunction(POST, db(), null, { action: 'invite', pageId: 'p1' });
    await expectErrorResponse(res, 401, 'Authentication required.');
  });

  describe('setWebSharing', () => {
    it('creates an enabled share link and marks the page public', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, {
        action: 'setWebSharing',
        pageId: 'p1',
        enabled: true,
      })) as { page: Row; shareLink: Row };
      expect(res.page.isPublic).toBe(true);
      expect(res.shareLink.enabled).toBe(true);
      expect(res.shareLink.role).toBe('view');
      expect(typeof res.shareLink.token).toBe('string');
      expect(database.tables.share_links).toHaveLength(1);
    });

    it('disables an existing link instead of minting a new one', async () => {
      const database = db({
        share_links: [
          { id: 'sl1', pageId: 'p1', workspaceId: 'ws1', token: 'tok', enabled: true, role: 'view' },
        ],
        pages: [pageRow('p1', { isPublic: true })],
      });
      const res = (await callFunction(POST, database, OWNER, {
        action: 'setWebSharing',
        pageId: 'p1',
        enabled: false,
      })) as { page: Row; shareLink: Row };
      expect(res.shareLink.id).toBe('sl1');
      expect(res.shareLink.enabled).toBe(false);
      expect(res.page.isPublic).toBe(false);
      expect(database.tables.share_links).toHaveLength(1);
    });

    it('rejects a non-boolean enabled flag at the entry', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'setWebSharing',
        pageId: 'p1',
        enabled: 'yes',
      });
      await expectErrorResponse(res, 400, 'enabled must be a boolean.');
    });

    it('is blocked by an organization DLP policy', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        organization_enterprise_controls: [
          { id: 'ec1', organizationId: 'org1', dlpPolicy: { enabled: true, blockPublicSharing: true } },
        ],
        pages: [pageRow('p1')],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'setWebSharing',
        pageId: 'p1',
        enabled: true,
      });
      await expectErrorResponse(res, 400, 'blocked by organization DLP policy');
      expect(database.tables.share_links ?? []).toHaveLength(0);
    });

    it('denies actors who cannot manage page access', async () => {
      const res = await callFunction(POST, db(), STRANGER, {
        action: 'setWebSharing',
        pageId: 'p1',
        enabled: true,
      });
      await expectErrorResponse(res, 403, 'Forbidden');
    });
  });

  describe('invite', () => {
    it('derives a stable record id from the page and normalized principal', async () => {
      const lower = await pagePermissionRecordId('p1', 'email', 'guest.user@example.com');
      const mixed = await pagePermissionRecordId('p1', 'email', 'Guest.User@Example.COM');
      const otherPage = await pagePermissionRecordId('p2', 'email', 'guest.user@example.com');
      expect(lower).toBe(mixed);
      expect(lower).toMatch(/^permission_[a-f0-9]{64}$/);
      expect(otherPage).not.toBe(lower);
    });

    it('creates an email permission for the invited address', async () => {
      const database = db();
      const res = (await callFunction(POST, database, OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'guest.user@example.com',
        role: 'edit',
      })) as { permissions: Row[] };
      expect(database.tables.page_permissions).toHaveLength(1);
      const permission = database.tables.page_permissions[0];
      expect(permission.principalType).toBe('email');
      expect(permission.principalId).toBe('guest.user@example.com');
      expect(permission.role).toBe('edit');
      expect(res.permissions).toBeDefined();
    });

    it('writes the permission and the audit event atomically for organization workspaces', async () => {
      const database = fakeDb({
        workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER, organizationId: 'org1' }],
        organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER }],
        pages: [pageRow('p1')],
      });
      await callFunction(POST, database, OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'guest.user@example.com',
        role: 'view',
      });
      expect(database.tables.page_permissions).toHaveLength(1);
      expect(database.tables.organization_audit_events).toHaveLength(1);
      expect(database.tables.organization_audit_events[0].action).toBe('page_permission.grant');
    });

    it('aborts with Forbidden and writes nothing when ownership changes mid-flight', async () => {
      const database = db();
      const originalTransact = database.transact.bind(database);
      database.transact = async (operations) => {
        // Simulate a concurrent owner transfer between the manage-access check
        // and the transactional write; the expect guard must catch it.
        database.tables.workspaces[0].ownerId = 'usurper-1';
        return originalTransact(operations);
      };
      const res = await callFunction(POST, database, OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'guest.user@example.com',
        role: 'view',
      });
      await expectErrorResponse(res, 403, 'Forbidden');
      expect(database.tables.page_permissions ?? []).toHaveLength(0);
      expect(database.tables.organization_audit_events ?? []).toHaveLength(0);
    });

    it('updates the existing permission when the principal is re-invited with different casing', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'perm1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'email',
            principalId: 'guest.user@example.com',
            label: 'guest.user@example.com',
            role: 'view',
          },
        ],
      });
      await callFunction(POST, database, OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'Guest.User@Example.COM',
        role: 'full_access',
      });
      expect(database.tables.page_permissions).toHaveLength(1);
      expect(database.tables.page_permissions[0].role).toBe('full_access');
    });

    it('keeps simultaneous grants for the same principal atomic and unique', async () => {
      const database = db();
      await Promise.all([
        callFunction(POST, database, OWNER, {
          action: 'invite',
          pageId: 'p1',
          email: 'race@example.com',
          role: 'view',
        }),
        callFunction(POST, database, OWNER, {
          action: 'invite',
          pageId: 'p1',
          email: 'RACE@example.com',
          role: 'edit',
        }),
      ]);

      expect(database.tables.page_permissions).toHaveLength(1);
      expect(database.tables.page_permissions[0].id).toBe(
        await pagePermissionRecordId('p1', 'email', 'race@example.com'),
      );
      expect(['view', 'edit']).toContain(database.tables.page_permissions[0].role);
    });

    it('consolidates legacy duplicate rows when the principal is invited again', async () => {
      const database = db({
        page_permissions: [
          {
            id: 'legacy-1',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'email',
            principalId: 'duplicate@example.com',
            label: 'duplicate@example.com',
            role: 'view',
          },
          {
            id: 'legacy-2',
            pageId: 'p1',
            workspaceId: 'ws1',
            principalType: 'email',
            principalId: 'DUPLICATE@example.com',
            label: 'DUPLICATE@example.com',
            role: 'edit',
          },
        ],
      });

      await callFunction(POST, database, OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'duplicate@example.com',
        role: 'comment',
      });

      expect(database.tables.page_permissions).toHaveLength(1);
      expect(database.tables.page_permissions[0]).toMatchObject({ id: 'legacy-1', role: 'comment' });
    });

    it('rejects an unknown role', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: 'guest@example.com',
        role: 'superadmin',
      });
      await expectErrorResponse(res, 400, 'role must be view, comment, edit, or full_access.');
    });

    it('rejects an oversized email at the entry', async () => {
      const res = await callFunction(POST, db(), OWNER, {
        action: 'invite',
        pageId: 'p1',
        email: `${'x'.repeat(320)}@example.com`,
        role: 'view',
      });
      await expectErrorResponse(res, 400, 'email must be at most 320 characters.');
    });

    it('denies actors who cannot manage page access', async () => {
      const res = await callFunction(POST, db(), STRANGER, {
        action: 'invite',
        pageId: 'p1',
        email: 'guest@example.com',
      });
      await expectErrorResponse(res, 403, 'Forbidden');
    });
  });

  describe('updatePermission / removePermission', () => {
    const permissionRow: Row = {
      id: 'perm1',
      pageId: 'p1',
      workspaceId: 'ws1',
      principalType: 'email',
      principalId: 'guest@example.com',
      label: 'guest@example.com',
      role: 'view',
    };

    it('changes the role of an existing permission', async () => {
      const database = db({ page_permissions: [{ ...permissionRow }] });
      await callFunction(POST, database, OWNER, {
        action: 'updatePermission',
        permissionId: 'perm1',
        role: 'comment',
      });
      expect(database.tables.page_permissions[0].role).toBe('comment');
    });

    it('removes a permission', async () => {
      const database = db({ page_permissions: [{ ...permissionRow }] });
      await callFunction(POST, database, OWNER, {
        action: 'removePermission',
        permissionId: 'perm1',
      });
      expect(database.tables.page_permissions).toHaveLength(0);
    });

    it('revokes every legacy duplicate for the same page principal', async () => {
      const database = db({
        page_permissions: [
          { ...permissionRow, id: 'perm1', role: 'view' },
          { ...permissionRow, id: 'perm2', principalId: 'GUEST@example.com', role: 'edit' },
        ],
      });
      await callFunction(POST, database, OWNER, {
        action: 'removePermission',
        permissionId: 'perm1',
      });
      expect(database.tables.page_permissions).toHaveLength(0);
    });

    it('consolidates duplicate rows while updating a role', async () => {
      const database = db({
        page_permissions: [
          { ...permissionRow, id: 'perm1', role: 'view' },
          { ...permissionRow, id: 'perm2', principalId: 'GUEST@example.com', role: 'full_access' },
        ],
      });
      await callFunction(POST, database, OWNER, {
        action: 'updatePermission',
        permissionId: 'perm1',
        role: 'comment',
      });
      expect(database.tables.page_permissions).toHaveLength(1);
      expect(database.tables.page_permissions[0]).toMatchObject({ id: 'perm1', role: 'comment' });
    });

    it('denies strangers', async () => {
      const database = db({ page_permissions: [{ ...permissionRow }] });
      const res = await callFunction(POST, database, STRANGER, {
        action: 'removePermission',
        permissionId: 'perm1',
      });
      await expectErrorResponse(res, 403, 'Forbidden');
      expect(database.tables.page_permissions).toHaveLength(1);
    });

    it('does not report a stale missing permission id as successfully revoked', async () => {
      const database = db({
        page_permission_index: [{
          id: 'stale-permission',
          workspaceId: 'ws1',
          pageId: 'p1',
          principalType: 'email',
          principalId: 'guest@example.com',
        }],
      });
      const res = await callFunction(POST, database, OWNER, {
        action: 'removePermission',
        permissionId: 'stale-permission',
      });
      await expectErrorResponse(res, 404, 'not found');
    });
  });
});
