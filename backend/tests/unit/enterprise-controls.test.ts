import { describe, expect, it } from 'vitest';

import {
  assertNoActiveLegalHoldForPermanentDelete,
  assertOrganizationDlpPolicy,
  organizationDlpPolicyAllows,
  type DbRef,
} from '../../lib/enterprise-controls';
import { fakeDb as makeFakeDb, type Row } from './helpers/fake-db';

function fakeDb(tables: Record<string, Row[]> = {}): DbRef {
  return makeFakeDb(tables) as unknown as DbRef;
}

function orgDb(options: {
  organizationId?: string | null;
  dlpPolicy?: Record<string, unknown> | null;
  holds?: Array<Record<string, unknown>>;
} = {}) {
  const { organizationId = 'org1', dlpPolicy, holds = [] } = options;
  return fakeDb({
    workspaces: [{ id: 'ws1', organizationId } as Row],
    organization_enterprise_controls: dlpPolicy === undefined
      ? []
      : [{ id: 'ec1', organizationId: 'org1', dlpPolicy } as Row],
    organization_legal_holds: holds.map((hold, index) => ({ id: `hold-${index}`, organizationId: 'org1', ...hold } as Row)),
  });
}

describe('organizationDlpPolicyAllows', () => {
  it('returns the fallback when there is no workspace context', async () => {
    const db = fakeDb();
    expect(await organizationDlpPolicyAllows(db, null, 'publicSharing')).toBe(true);
    expect(await organizationDlpPolicyAllows(db, undefined, 'publicSharing', false)).toBe(false);
  });

  it('returns the fallback for unknown workspaces and workspaces without an organization', async () => {
    expect(await organizationDlpPolicyAllows(fakeDb(), 'missing-ws', 'publicSharing', false)).toBe(false);
    expect(await organizationDlpPolicyAllows(orgDb({ organizationId: null }), 'ws1', 'publicSharing', false)).toBe(false);
  });

  it('returns the fallback when no controls record exists', async () => {
    expect(await organizationDlpPolicyAllows(orgDb(), 'ws1', 'publicSharing', false)).toBe(false);
  });

  it('returns the fallback unless the policy is explicitly enabled', async () => {
    expect(await organizationDlpPolicyAllows(orgDb({ dlpPolicy: null }), 'ws1', 'publicSharing', false)).toBe(false);
    expect(
      await organizationDlpPolicyAllows(
        orgDb({ dlpPolicy: { enabled: false, blockPublicSharing: true } }),
        'ws1',
        'publicSharing',
      ),
    ).toBe(true);
    expect(
      await organizationDlpPolicyAllows(
        orgDb({ dlpPolicy: { enabled: 'yes', blockPublicSharing: true } }),
        'ws1',
        'publicSharing',
      ),
    ).toBe(true);
  });

  it('blocks actions whose block flag is set on an enabled policy', async () => {
    const db = orgDb({
      dlpPolicy: {
        enabled: true,
        blockPublicSharing: true,
        blockExternalSharing: true,
        blockFileDownloads: false,
      },
    });
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'publicSharing')).toBe(false);
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'externalSharing')).toBe(false);
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'fileDownloads')).toBe(true);
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'exports')).toBe(true);
  });

  it('blocks exports when blockExports is set', async () => {
    const db = orgDb({ dlpPolicy: { enabled: true, blockExports: true } });
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'exports')).toBe(false);
  });

  it('returns the fallback for unknown policy keys even when enabled', async () => {
    const db = orgDb({ dlpPolicy: { enabled: true, blockPublicSharing: true } });
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'unknownKey')).toBe(true);
    expect(await organizationDlpPolicyAllows(db, 'ws1', 'unknownKey', false)).toBe(false);
  });
});

describe('assertOrganizationDlpPolicy', () => {
  it('throws the provided message when the policy blocks the action', async () => {
    const db = orgDb({ dlpPolicy: { enabled: true, blockPublicSharing: true } });
    await expect(
      assertOrganizationDlpPolicy(db, 'ws1', 'publicSharing', 'Public sharing is blocked.'),
    ).rejects.toThrow('Public sharing is blocked.');
  });

  it('resolves when the policy allows the action', async () => {
    const db = orgDb({ dlpPolicy: { enabled: true, blockPublicSharing: false } });
    await expect(
      assertOrganizationDlpPolicy(db, 'ws1', 'publicSharing', 'Public sharing is blocked.'),
    ).resolves.toBeUndefined();
  });
});

describe('assertNoActiveLegalHoldForPermanentDelete', () => {
  it('resolves without a workspace or without pages', async () => {
    const db = orgDb({ holds: [{ name: 'Hold', scope: { all: true } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, null, ['p1'])).resolves.toBeUndefined();
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', [])).resolves.toBeUndefined();
  });

  it('resolves for workspaces without an organization', async () => {
    const db = orgDb({ organizationId: null, holds: [{ name: 'Hold' }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).resolves.toBeUndefined();
  });

  it('resolves when there are no holds', async () => {
    await expect(assertNoActiveLegalHoldForPermanentDelete(orgDb(), 'ws1', ['p1'])).resolves.toBeUndefined();
  });

  it('treats an empty scope as covering everything', async () => {
    const db = orgDb({ holds: [{ name: 'Litigation A', scope: {} }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).rejects.toThrow(
      'Active legal hold prevents permanent deletion: Litigation A',
    );
  });

  it('treats a missing scope and scope.all as covering everything', async () => {
    await expect(
      assertNoActiveLegalHoldForPermanentDelete(orgDb({ holds: [{ name: 'H1' }] }), 'ws1', ['p1']),
    ).rejects.toThrow('H1');
    await expect(
      assertNoActiveLegalHoldForPermanentDelete(orgDb({ holds: [{ name: 'H2', scope: { all: true } }] }), 'ws1', ['p1']),
    ).rejects.toThrow('H2');
  });

  it('applies workspace-scoped holds only to that workspace', async () => {
    const matching = orgDb({ holds: [{ name: 'WS Hold', scope: { workspaceIds: ['ws1'] } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(matching, 'ws1', ['p1'])).rejects.toThrow('WS Hold');

    const other = orgDb({ holds: [{ name: 'WS Hold', scope: { workspaceIds: ['ws-other'] } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(other, 'ws1', ['p1'])).resolves.toBeUndefined();
  });

  it('applies page-scoped holds when any page overlaps', async () => {
    const db = orgDb({ holds: [{ name: 'Page Hold', scope: { pageIds: ['p2', 'p3'] } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1', 'p3'])).rejects.toThrow('Page Hold');
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).resolves.toBeUndefined();
  });

  it('falls through workspace scope to page scope', async () => {
    const db = orgDb({
      holds: [{ name: 'Mixed', scope: { workspaceIds: ['ws-other'], pageIds: ['p1'] } }],
    });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).rejects.toThrow('Mixed');
  });

  it('ignores non-string entries in scope lists', async () => {
    const db = orgDb({ holds: [{ name: 'Bad Scope', scope: { workspaceIds: [123, ''], pageIds: [null] } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).resolves.toBeUndefined();
  });

  it('ignores released holds but defaults missing status to active', async () => {
    const released = orgDb({ holds: [{ name: 'Released', status: 'released', scope: { all: true } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(released, 'ws1', ['p1'])).resolves.toBeUndefined();

    const defaulted = orgDb({ holds: [{ name: 'Default', status: null, scope: { all: true } }] });
    await expect(assertNoActiveLegalHoldForPermanentDelete(defaulted, 'ws1', ['p1'])).rejects.toThrow('Default');
  });

  it('reports the first blocking hold when several apply', async () => {
    const db = orgDb({
      holds: [
        { name: 'Skipped', status: 'released' },
        { name: 'First Active', scope: { all: true } },
        { name: 'Second Active', scope: {} },
      ],
    });
    await expect(assertNoActiveLegalHoldForPermanentDelete(db, 'ws1', ['p1'])).rejects.toThrow('First Active');
  });
});
