import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/auth-audit';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

// The email belongs to an organization member, so a recorded login attempt for
// it fans out to exactly one organization_audit_events row.
function dbWithKnownEmail(email: string) {
  return fakeDb({
    organizations: [{ id: 'org1', name: 'Org', ownerId: 'owner-1' }],
    organization_members: [
      { id: 'om1', organizationId: 'org1', userId: 'u-known', email, role: 'member', status: 'active' },
    ] as Row[],
  });
}

describe('auth-audit account-enumeration guard', () => {
  it('does not disclose the matched-organization count to an unauthenticated caller', async () => {
    const db = dbWithKnownEmail('known@example.com');
    const result = (await callFunction(POST, db, null, {
      action: 'record',
      method: 'password_signin',
      phase: 'verify',
      outcome: 'failure',
      email: 'known@example.com',
    })) as { recorded: unknown };

    // The count would be an oracle for "does this email belong to the instance".
    expect(result.recorded).toBe(true);
    expect(typeof result.recorded).not.toBe('number');
    // Recording still happens — the event is written, only the count is withheld.
    expect(db.tables.organization_audit_events).toHaveLength(1);
  });

  it('still discloses the count to an authenticated caller (audit smokes rely on it)', async () => {
    const db = dbWithKnownEmail('u-actor@example.com');
    const result = (await callFunction(POST, db, 'u-actor', {
      action: 'record',
      method: 'password_signin',
      phase: 'verify',
      outcome: 'success',
    })) as { recorded: unknown };

    expect(typeof result.recorded).toBe('number');
    expect(result.recorded as number).toBeGreaterThanOrEqual(1);
  });
});

describe('auth-audit log-injection guard', () => {
  it('strips control characters from the attacker-controlled reason', async () => {
    const db = dbWithKnownEmail('known@example.com');
    await callFunction(POST, db, null, {
      action: 'record',
      method: 'password_signin',
      phase: 'verify',
      outcome: 'failure',
      email: 'known@example.com',
      reason: 'attempt\nfrom\tbot',
    });

    const event = db.tables.organization_audit_events[0];
    const reason = (event.metadata as { reason?: string }).reason ?? '';
    expect(reason).toBe('attempt from bot');
    expect(reason).not.toMatch(/[\n\r\t]/);
  });
});
