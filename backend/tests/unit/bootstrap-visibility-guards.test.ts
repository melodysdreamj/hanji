import { describe, expect, it } from 'vitest';
import type { DbRef } from '../../lib/app-types';
import {
  CHANGE_LOG_TABLE,
  type ChangeLogEntry,
} from '../../lib/workspace-db';
import {
  CHANGE_CURSOR_SAFETY_WINDOW_MS,
  commitOrderKey,
  conservativeChangeCursor,
  readChangeFeed,
} from '../../lib/change-log';
import { canUseChangesDeltaMode } from '../../functions/workspace-bootstrap';
import { fakeDb, type Row } from './helpers/fake-db';

const WORKSPACE = 'ws-1';

function entry(overrides: Partial<ChangeLogEntry> & { id: string; at: string }): Row {
  return {
    workspaceId: WORKSPACE,
    tbl: 'pages',
    recordId: overrides.id,
    scope: null,
    deleted: false,
    ...overrides,
  } as Row;
}

function dbWith(entries: Row[]): DbRef {
  return fakeDb({ [CHANGE_LOG_TABLE]: entries }) as unknown as DbRef;
}

describe('conservativeChangeCursor (change #11: stamp-to-commit window tombstone)', () => {
  it('backs off by the safety window so the stamp-to-commit boundary is re-read', () => {
    const latest = '2026-07-08T00:00:05.000Z';
    const cursor = conservativeChangeCursor(latest);
    expect(Date.parse(latest) - Date.parse(cursor)).toBe(CHANGE_CURSOR_SAFETY_WINDOW_MS);
    expect(cursor < latest).toBe(true);
  });

  it('returns the input unchanged when it is not a valid timestamp (NaN guard)', () => {
    expect(conservativeChangeCursor('not-a-date')).toBe('not-a-date');
    expect(conservativeChangeCursor('')).toBe('');
  });

  it('re-delivers a tombstone stamped at the previous latest millisecond', async () => {
    // First sync: one page edit sets latestAt. A strict `at > since` cursor of
    // exactly latestAt would permanently skip anything landing in that same ms.
    const editAt = '2026-07-08T00:00:00.500Z';
    const firstFeed = await readChangeFeed(
      dbWith([entry({ id: 'p1', at: editAt })]),
      WORKSPACE,
      '2026-07-08T00:00:00.000Z',
    );
    expect(firstFeed.complete).toBe(true);
    expect(firstFeed.latestAt).toBe(editAt);

    // A tombstone commits in the same millisecond but lands after the read.
    const withTombstone = dbWith([
      entry({ id: 'p1', at: editAt }),
      entry({ id: 'p2', at: editAt, deleted: true }),
    ]);

    // Strict cursor at exactly latestAt would drop the tombstone...
    const strictCursorFeed = await readChangeFeed(withTombstone, WORKSPACE, firstFeed.latestAt);
    expect(strictCursorFeed.deletedPageIds).not.toContain('p2');

    // ...but the safety-window-backed-off cursor re-reads the boundary and delivers it.
    const conservativeFeed = await readChangeFeed(
      withTombstone,
      WORKSPACE,
      conservativeChangeCursor(firstFeed.latestAt),
    );
    expect(conservativeFeed.deletedPageIds).toContain('p2');
  });

  it('re-delivers a tombstone whose commit lagged its stamp within the safety window', async () => {
    // A cascade stamps a tombstone earlier than a concurrent small edit, but
    // commits it AFTER the edit — so it lands after the first sync read. A naive
    // cursor of exactly latestAt would drop it forever (its `at` < since); the
    // safety-window backoff re-scans the window and delivers it.
    const editAt = '2026-07-08T00:00:10.000Z';
    const tombstoneAt = '2026-07-08T00:00:09.500Z'; // 500ms behind, inside the 2000ms window
    expect(Date.parse(editAt) - Date.parse(tombstoneAt)).toBeLessThan(CHANGE_CURSOR_SAFETY_WINDOW_MS);

    const firstFeed = await readChangeFeed(
      dbWith([entry({ id: 'p1', at: editAt })]),
      WORKSPACE,
      '2026-07-08T00:00:00.000Z',
    );
    const cursor = conservativeChangeCursor(firstFeed.latestAt);

    const withLateTombstone = dbWith([
      entry({ id: 'p1', at: editAt }),
      entry({ id: 'p2', at: tombstoneAt, deleted: true }),
    ]);
    const nextFeed = await readChangeFeed(withLateTombstone, WORKSPACE, cursor);
    expect(nextFeed.deletedPageIds).toContain('p2');
  });
});

describe('commit-order change feed (no skipped tombstone regardless of timing)', () => {
  // The DatabaseDO stamps `createdAt` inside its serialized transactionSync at
  // the actual commit point, so it reflects TRUE commit order (see
  // commitOrderKey / workspace-db.ts ChangeLogEntry.createdAt). These tests
  // simulate that: `at` is the worker's pre-commit stamp, `createdAt` is the
  // DO's commit-time stamp.

  it('prefers the DO commit-time createdAt as the order key, falling back to at', () => {
    expect(
      commitOrderKey(entry({ id: 'x', at: '2026-07-08T00:00:00.000Z', createdAt: '2026-07-08T00:00:09.000Z' })),
    ).toBe('2026-07-08T00:00:09.000Z');
    // Fallback for test fakes / pre-auto-field rows.
    expect(commitOrderKey(entry({ id: 'y', at: '2026-07-08T00:00:03.000Z' }))).toBe(
      '2026-07-08T00:00:03.000Z',
    );
  });

  // The pathological case the old `at`-ordered feed could not handle: a large
  // cascade is worker-stamped FAR in the past (well beyond the 2s safety
  // window), yet commits AFTER a small edit that a client already synced past.
  // Because ordering is now keyed on commit time, the cascade's tombstone is
  // still delivered on the next sync — for ANY stamp→commit skew.
  for (const skewMs of [
    CHANGE_CURSOR_SAFETY_WINDOW_MS + 1_000, // just past the window
    60_000, // a minute
    60 * 60_000, // an hour — clearly unbounded by the window
  ]) {
    it(`delivers a cascade tombstone stamped ${skewMs}ms in the past but committed later`, async () => {
      const smallCommittedAt = '2026-07-08T01:00:00.000Z';
      // Worker-stamped skewMs BEFORE the small edit (the cascade was constructed
      // first, then queued); its DO commit landed AFTER the small edit.
      const cascadeStampedAt = new Date(Date.parse(smallCommittedAt) - skewMs).toISOString();
      const cascadeCommittedAt = '2026-07-08T01:00:05.000Z';
      expect(skewMs).toBeGreaterThan(CHANGE_CURSOR_SAFETY_WINDOW_MS);

      // Sync 1 — only the small edit is durable yet.
      const firstFeed = await readChangeFeed(
        dbWith([entry({ id: 'p1', at: smallCommittedAt, createdAt: smallCommittedAt })]),
        WORKSPACE,
        '2026-07-08T00:59:55.000Z',
      );
      expect(firstFeed.complete).toBe(true);
      expect(firstFeed.latestAt).toBe(smallCommittedAt); // commit-order latest, not the future cascade
      const cursor = conservativeChangeCursor(firstFeed.latestAt);

      // Cascade commits (its tombstone becomes durable) AFTER sync 1.
      const afterCascade = dbWith([
        entry({ id: 'p1', at: smallCommittedAt, createdAt: smallCommittedAt }),
        entry({ id: 'del', at: cascadeStampedAt, createdAt: cascadeCommittedAt, deleted: true }),
      ]);

      // Sync 2 — the tombstone IS delivered, even though its worker `at` is
      // skewMs (>> window) behind the cursor.
      const nextFeed = await readChangeFeed(afterCascade, WORKSPACE, cursor);
      expect(nextFeed.deletedPageIds).toContain('del');
    });
  }

  it('shows the fix is load-bearing: the same skew keyed on `at` alone would be skipped', async () => {
    // Identical scenario minus createdAt: commitOrderKey falls back to the
    // worker `at`, which is an hour behind the cursor → the old, broken result.
    const smallCommittedAt = '2026-07-08T01:00:00.000Z';
    const cascadeStampedAt = '2026-07-08T00:00:00.000Z'; // an hour earlier

    const firstFeed = await readChangeFeed(
      dbWith([entry({ id: 'p1', at: smallCommittedAt })]),
      WORKSPACE,
      '2026-07-08T00:59:55.000Z',
    );
    const cursor = conservativeChangeCursor(firstFeed.latestAt);

    const afterCascade = dbWith([
      entry({ id: 'p1', at: smallCommittedAt }),
      entry({ id: 'del', at: cascadeStampedAt, deleted: true }),
    ]);
    const nextFeed = await readChangeFeed(afterCascade, WORKSPACE, cursor);
    // Without the DO commit-time key, this tombstone is lost — which is exactly
    // the hole commitOrderKey closes above.
    expect(nextFeed.deletedPageIds).not.toContain('del');
  });

  it('reports the newest commit-order key as latestAt even when a stale `at` sorts last', async () => {
    // An entry stamped far in the past but committed most recently must set the
    // cursor, or the next sync would re-scan from a stale point forever.
    const feed = await readChangeFeed(
      dbWith([
        entry({ id: 'a', at: '2026-07-08T00:00:10.000Z', createdAt: '2026-07-08T00:00:10.000Z' }),
        entry({ id: 'b', at: '2026-07-08T00:00:00.000Z', createdAt: '2026-07-08T00:00:20.000Z' }),
      ]),
      WORKSPACE,
      '2026-07-08T00:00:05.000Z',
    );
    expect(feed.latestAt).toBe('2026-07-08T00:00:20.000Z');
  });
});

describe('canUseChangesDeltaMode (changes #10/#12: feed leaks / stale visibility)', () => {
  const cleanFeed = { complete: true, permissionsTouched: false };

  it('members with full workspace access get O(changes) mode', () => {
    expect(canUseChangesDeltaMode(true, cleanFeed)).toBe(true);
  });

  it('non-members (no full workspace access) never get O(changes) mode', () => {
    // Falls through to visibility-filtered 'ids' mode even on a clean feed.
    expect(canUseChangesDeltaMode(false, cleanFeed)).toBe(false);
  });

  it('is refused when the feed is incomplete or permissions were touched', () => {
    expect(canUseChangesDeltaMode(true, { complete: false, permissionsTouched: false })).toBe(false);
    expect(canUseChangesDeltaMode(true, { complete: true, permissionsTouched: true })).toBe(false);
  });
});
