import { describe, expect, it } from 'vitest';

import { POST, normalizeExpiresIn, secondsFromDuration } from '../../functions/file-mutation';
import { fakeDb, type FakeDb } from './helpers/fake-db';
import { callFunction, expectErrorResponse, handlerOf } from './helpers/function-context';

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const OWNER = 'owner-1';

describe('normalizeExpiresIn signed-URL TTL clamp', () => {
  it('defaults to one hour when absent or blank', () => {
    expect(secondsFromDuration(normalizeExpiresIn(undefined))).toBe(3600);
    expect(secondsFromDuration(normalizeExpiresIn('   '))).toBe(3600);
  });

  it('preserves a reasonable requested TTL', () => {
    expect(secondsFromDuration(normalizeExpiresIn('15m'))).toBe(900);
    expect(secondsFromDuration(normalizeExpiresIn('2h'))).toBe(7200);
  });

  it('clamps an oversized TTL so no caller can mint a permanent URL', () => {
    expect(secondsFromDuration(normalizeExpiresIn('3650d'))).toBe(MAX_TTL_SECONDS);
    expect(secondsFromDuration(normalizeExpiresIn('999999h'))).toBe(MAX_TTL_SECONDS);
    // The 7-day cap itself is allowed through unchanged.
    expect(secondsFromDuration(normalizeExpiresIn('7d'))).toBe(MAX_TTL_SECONDS);
  });

  it('rejects malformed durations', () => {
    expect(() => normalizeExpiresIn('soon')).toThrow('expiresIn is invalid.');
    expect(() => normalizeExpiresIn('10x')).toThrow('expiresIn is invalid.');
  });
});

describe('statusForError target-mismatch family', () => {
  it('maps "outside the …" target mismatches to 400 instead of 500', async () => {
    const database = fakeDb({
      workspaces: [{ id: 'ws1', name: 'Workspace', ownerId: OWNER }],
      pages: [
        { id: 'p1', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', inTrash: false, createdBy: OWNER },
        { id: 'p2', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', inTrash: false, createdBy: OWNER },
      ],
      blocks: [{ id: 'b1', pageId: 'p1', type: 'paragraph', position: 0 }],
    });
    const res = await callFunction(POST, database, OWNER, {
      action: 'prepareUpload',
      pageId: 'p2',
      blockId: 'b1',
      name: 'photo.png',
      size: 100,
    });
    await expectErrorResponse(res, 400, 'Target block is outside the page.');
  });
});

describe('organization storage limit across workspace shards', () => {
  // Post-split, each workspace's file_uploads live in that workspace's own
  // DO. The limit check must read sibling workspaces through their own
  // handles — through the CURRENT workspace's facade they are always empty
  // and the org-wide cap silently never trips.
  function shardedContext(body: Record<string, unknown>) {
    const central = fakeDb({
      workspaces: [
        { id: 'ws1', name: 'One', ownerId: OWNER, organizationId: 'org1' },
        { id: 'ws2', name: 'Two', ownerId: OWNER, organizationId: 'org1' },
      ],
      organizations: [{ id: 'org1', name: 'Org', ownerId: OWNER, storageLimitBytes: 1000 }],
    });
    const shards: Record<string, FakeDb> = {
      ws1: fakeDb({ file_uploads: [] }),
      ws2: fakeDb({
        file_uploads: [
          {
            id: 'u-existing',
            workspaceId: 'ws2',
            bucket: 'files',
            key: 'workspaces/ws2/uploads/u-existing-big.bin',
            scope: 'uploads',
            name: 'big.bin',
            size: 900,
            status: 'uploaded',
            createdBy: OWNER,
          },
        ],
      }),
    };
    return {
      shards,
      context: {
        auth: { id: OWNER, email: `${OWNER}@example.com` },
        admin: {
          db: (namespace: string, instanceId?: string) =>
            namespace === 'app' || !instanceId ? central : shards[instanceId] ?? fakeDb(),
        },
        request: new Request('http://localhost:8787/functions/test', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      },
    };
  }

  it("counts sibling workspaces' usage toward the organization limit", async () => {
    const { context } = shardedContext({
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'new.bin',
      size: 200,
    });
    const res = await handlerOf(POST)(context);
    // 900 bytes already reserved in ws2 + 200 requested > the 1000-byte cap.
    await expectErrorResponse(res, 403, 'Organization storage limit exceeded.');
  });

  it('allows an upload that fits under the organization-wide usage', async () => {
    const { shards, context } = shardedContext({
      action: 'prepareUpload',
      workspaceId: 'ws1',
      name: 'small.bin',
      size: 50,
    });
    const res = (await handlerOf(POST)(context)) as { upload?: { id: string } };
    expect(res.upload?.id).toBeTruthy();
    expect(shards.ws1.tables.file_uploads).toHaveLength(1);
  });
});
