import { describe, expect, it } from 'vitest';

import { POST } from '../../functions/auth-audit';
import { csvCell } from '../../functions/import-export';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

describe('csvCell formula-injection guard', () => {
  it('prefixes a quote to values that begin with a spreadsheet formula sigil', () => {
    expect(csvCell('=HYPERLINK("http://evil","x")')).toBe(
      '"\'=HYPERLINK(""http://evil"",""x"")"',
    );
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@x')).toBe("'@x");
    // A leading TAB is a known Excel formula-execution vector.
    expect(csvCell('\tcmd')).toBe("'\tcmd");
  });

  it('leaves a normal value untouched', () => {
    expect(csvCell('hello')).toBe('hello');
  });

  it('still applies RFC-4180 quoting on top of neutralization', () => {
    // A neutralized value that also contains a comma must be quoted.
    expect(csvCell('=a,b')).toBe('"\'=a,b"');
  });
});

// The email belongs to an organization member, so a recorded login attempt for
// it fans out to exactly one organization_audit_events row when recording is
// permitted.
function dbWithKnownEmail(email: string) {
  return fakeDb({
    organizations: [{ id: 'org1', name: 'Org', ownerId: 'owner-1' }],
    organization_members: [
      { id: 'om1', organizationId: 'org1', userId: 'u-known', email, role: 'member', status: 'active' },
    ] as Row[],
    // Materialize the table so length assertions hold when nothing is written.
    organization_audit_events: [] as Row[],
  });
}

describe('auth-audit unauthenticated forging guard', () => {
  it('drops a forged unauthenticated success event', async () => {
    const db = dbWithKnownEmail('known@example.com');
    await callFunction(POST, db, null, {
      action: 'record',
      method: 'password_signin',
      phase: 'verify',
      outcome: 'success',
      email: 'known@example.com',
    });

    // An attacker with only a victim email must not be able to write a forged
    // 'success' login event for the victim's organization.
    expect(db.tables.organization_audit_events).toHaveLength(0);
  });

  it('still records the legitimate pre-auth failure path', async () => {
    const db = dbWithKnownEmail('known@example.com');
    await callFunction(POST, db, null, {
      action: 'record',
      method: 'password_signin',
      phase: 'verify',
      outcome: 'failure',
      email: 'known@example.com',
    });

    // AuthGate's pre-auth FAILURE recording must keep working.
    expect(db.tables.organization_audit_events).toHaveLength(1);
  });
});
