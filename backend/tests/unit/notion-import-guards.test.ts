import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { POST, readResponseBodyWithByteCap, type NotionImportJob } from '../../functions/notion-import';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

const DAY_MS = 24 * 60 * 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

function job(id: string, extra: Partial<NotionImportJob> = {}): Row {
  return {
    id,
    workspaceId: 'ws-1',
    source: 'notion_api',
    connectionKind: 'manual_token',
    status: 'ready',
    phase: 'review',
    apiVersion: '2022-06-28',
    createdAt: isoAgo(DAY_MS),
    updatedAt: isoAgo(DAY_MS),
    ...extra,
  } as unknown as Row;
}

function workspaceDb(extra: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws-1', name: 'Workspace', ownerId: 'owner-1' }],
    workspace_members: [
      { id: 'm-owner', workspaceId: 'ws-1', userId: 'owner-1', role: 'owner' },
      { id: 'm-guest', workspaceId: 'ws-1', userId: 'guest-1', role: 'guest' },
      { id: 'm-member', workspaceId: 'ws-1', userId: 'member-1', role: 'member' },
    ],
    notion_import_items: [],
    ...extra,
  });
}

describe('applyJob authorizes before arming the failure marker (#6)', () => {
  it("an unauthorized stranger's 403 leaves the ready job untouched", async () => {
    const db = workspaceDb({ notion_import_jobs: [job('job-1')] });
    const res = await callFunction(POST, db, 'intruder-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });
    await expectErrorResponse(res, 403, 'Workspace access required.');
    const row = db.tables.notion_import_jobs.find((candidate) => candidate.id === 'job-1');
    expect(row?.status).toBe('ready');
    expect(row?.error ?? null).toBeNull();
    expect(row?.finishedAt ?? null).toBeNull();
  });

  it('still marks the job failed when an authorized apply fails after the guard', async () => {
    // No discovered items → applyJobCore throws after assertWritableJob passed,
    // so the failure marker must record it (progress must not stay stuck).
    const db = workspaceDb({ notion_import_jobs: [job('job-1')] });
    const res = await callFunction(POST, db, 'owner-1', {
      action: 'apply',
      jobId: 'job-1',
      workspaceId: 'ws-1',
    });
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBeGreaterThanOrEqual(400);
    const row = db.tables.notion_import_jobs.find((candidate) => candidate.id === 'job-1');
    expect(row?.status).toBe('failed');
    expect(row?.phase).toBe('apply_failed');
  });
});

describe('listJobs gates the destructive prune on edit access (#10)', () => {
  const staleJobs = () => [
    job('stale-1', { status: 'failed', createdAt: isoAgo(60 * DAY_MS), updatedAt: isoAgo(60 * DAY_MS) }),
    job('fresh-1', { status: 'completed' }),
  ];

  it('a view-only member lists jobs without hard-deleting stale rows', async () => {
    const db = workspaceDb({ notion_import_jobs: staleJobs() });
    const result = (await callFunction(POST, db, 'guest-1', {
      action: 'list',
      workspaceId: 'ws-1',
    })) as { jobs: Array<{ id: string }> };
    expect(result.jobs.map((item) => item.id).sort()).toEqual(['fresh-1', 'stale-1']);
    expect(db.tables.notion_import_jobs.map((row) => row.id).sort()).toEqual(['fresh-1', 'stale-1']);
  });

  it("an editor's listing still prunes stale jobs", async () => {
    const db = workspaceDb({ notion_import_jobs: staleJobs() });
    const result = (await callFunction(POST, db, 'member-1', {
      action: 'list',
      workspaceId: 'ws-1',
    })) as { jobs: Array<{ id: string }> };
    expect(result.jobs.map((item) => item.id)).toEqual(['fresh-1']);
    expect(db.tables.notion_import_jobs.map((row) => row.id)).toEqual(['fresh-1']);
  });
});

describe('discovery progress writes cannot land after the terminal update (#11)', () => {
  // The throttled onDiscoveryProgress writer lives in a closure inside
  // discoverJob (not unit-isolable without a live Notion fetch), so pin the
  // ordering contract at the source level: the finalizer must stop new ticks,
  // await the in-flight write, and run before BOTH terminal job updates.
  const source = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../functions/notion-import.ts'),
    'utf8',
  );

  it('onDiscoveryProgress skips once finalized and tracks the in-flight promise', () => {
    expect(source).toContain('if (progressFinalized || progressWriteInFlight) return;');
    expect(source).toContain('progressWriteInFlight = bestEffort(');
  });

  it('the finalizer awaits the in-flight write before ready and failed updates', () => {
    expect(source).toContain('const finalizeDiscoveryProgress = async () => {');
    expect(source).toMatch(/progressFinalized = true;\s*const inFlight = progressWriteInFlight;\s*if \(inFlight\) await inFlight\.catch/);
    expect(source).toMatch(/await finalizeDiscoveryProgress\(\);\s*const updated = await jobs\.update\(job\.id, \{\s*status: 'ready',/);
    expect(source).toMatch(/await finalizeDiscoveryProgress\(\);\s*const message = error instanceof Error/);
  });
});

describe('readResponseBodyWithByteCap (#12)', () => {
  function chunkedResponse(chunks: Uint8Array[], onPull?: () => void) {
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) {
          onPull?.();
          controller.enqueue(chunks[index]);
          index += 1;
        } else {
          controller.close();
        }
      },
    });
    return new Response(stream);
  }

  it('assembles a chunked body under the cap in order', async () => {
    const response = chunkedResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
    const buffer = await readResponseBodyWithByteCap(response, 10);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('aborts as soon as the running total crosses the cap instead of draining the stream', async () => {
    let pulls = 0;
    const chunks = Array.from({ length: 100 }, () => new Uint8Array(1024));
    const response = chunkedResponse(chunks, () => {
      pulls += 1;
    });
    await expect(readResponseBodyWithByteCap(response, 2048)).rejects.toThrow('source file is too large');
    // The reader must stop pulling once the cap is crossed — buffering all 100
    // chunks first is exactly the memory-exhaustion bug this guards against.
    expect(pulls).toBeLessThan(10);
  });

  it('handles a bodyless response through the fallback path', async () => {
    const buffer = await readResponseBodyWithByteCap(new Response(null), 4);
    expect(buffer.byteLength).toBe(0);
  });

  it('still rejects an oversized response when no body stream is exposed', async () => {
    const response = new Response('x'.repeat(64));
    Object.defineProperty(response, 'body', { value: null });
    await expect(readResponseBodyWithByteCap(response, 16)).rejects.toThrow('source file is too large');
  });
});
