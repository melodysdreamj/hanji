import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the files-bucket read IDOR (#1). Direct bucket reads must
// stay denied so all downloads route through file-mutation `signedUrl`, which
// runs assertUploadAccess. Authorizing reads on key shape alone
// (isWorkspaceFileKey) let any authenticated user read any workspace's files and
// survived access revocation.
const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = readFileSync(resolve(backendDir, 'edgebase.config.ts'), 'utf8');

function filesBucketBlock(): string {
  const start = config.indexOf('files: {');
  expect(start, 'files bucket block not found').toBeGreaterThan(-1);
  // Wide enough to include the read rule past its explanatory comment.
  return config.slice(start, start + 900);
}

describe('files storage bucket read rule (#1)', () => {
  it('denies direct reads (read: () => false)', () => {
    const block = filesBucketBlock();
    expect(block).toMatch(/read:\s*\(\)\s*=>\s*false/);
  });

  it('does not authorize reads on key shape alone', () => {
    const block = filesBucketBlock();
    expect(block).not.toContain('isWorkspaceFileKey');
    expect(block).not.toMatch(/read:\s*\(auth/);
  });
});
