// @vitest-environment jsdom
//
// Regression guards for three deep-review findings:
//   #5  BoardView — a filtered board must never write a filtered subset of the
//       group options back to the property (that permanently deletes the
//       hidden options: data loss).
//   #13 CalendarView — arrow-key reschedule must preserve the time-of-day and
//       the end date exactly like dragging, not collapse to a bare date key.
//   #14 recordCache — the database LRU must exempt offline-pinned databases
//       from eviction (an empty keep-set evicted them past the cap).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return { ...actual };
});

import { reorderGroupOptionsById } from "@/components/database/BoardView";
import { shiftDateValueByDays } from "@/components/database/CalendarView";
import {
  MAX_CACHED_DBS,
  cacheGetMeta,
  cacheListTable,
  cacheReplaceTable,
  recordCacheIdleForTests,
  resetRecordCacheForTests,
  setOfflinePin,
  stampDatabaseCached,
} from "@/lib/recordCache";
import { resetOutboxForTests } from "@/lib/outbox";
import { resetStore, seedUser, TEST_USER } from "./components/storeTestUtils";
import type { SelectOption } from "@/lib/types";

// ── #5 filtered board group reorder never drops hidden options ──────────────
describe("BoardView group-option reorder preserves hidden options (#5)", () => {
  const full: SelectOption[] = [
    { id: "a", name: "A", color: "red" },
    { id: "hidden", name: "Hidden", color: "blue" },
    { id: "b", name: "B", color: "green" },
    { id: "c", name: "C", color: "yellow" },
  ];

  it("keeps the filtered-out option when a visible option is reordered", () => {
    // The board filter hides `hidden`; the user drags visible option `c`
    // before visible option `a`. The mutation must rebuild the FULL list.
    const next = reorderGroupOptionsById(full, "c", "a");
    expect(next).not.toBeNull();
    expect(next!.map((o) => o.id)).toContain("hidden");
    expect(next!.map((o) => o.id)).toEqual(["c", "a", "hidden", "b"]);
    // The input array is not mutated.
    expect(full.map((o) => o.id)).toEqual(["a", "hidden", "b", "c"]);
  });

  it("returns null for a no-op or a missing id (no accidental write)", () => {
    expect(reorderGroupOptionsById(full, "a", "a")).toBeNull();
    expect(reorderGroupOptionsById(full, "", "a")).toBeNull();
    expect(reorderGroupOptionsById(full, "missing", "a")).toBeNull();
    expect(reorderGroupOptionsById(full, "a", "missing")).toBeNull();
  });
});

// ── #13 keyboard reschedule preserves time-of-day and end date ──────────────
describe("CalendarView arrow-key reschedule preserves time and end (#13)", () => {
  it("shifts a range string value while keeping both times and the end day", () => {
    const next = shiftDateValueByDays("2026-07-08T14:00/2026-07-10T16:00", 1);
    // Bare-date-key behaviour would have produced "2026-07-09"; instead the
    // start time, end date and end time all survive and the range shifts by a
    // day exactly like a drag.
    expect(next).toBe("2026-07-09T14:00/2026-07-11T16:00");
  });

  it("shifts a {start,end} payload value backwards preserving times", () => {
    const next = shiftDateValueByDays(
      { start: "2026-07-08T09:30", end: "2026-07-08T11:00" },
      -2
    );
    expect(next).toBe("2026-07-06T09:30/2026-07-06T11:00");
  });

  it("returns null for an unparseable value", () => {
    expect(shiftDateValueByDays("", 1)).toBeNull();
    expect(shiftDateValueByDays(null, 1)).toBeNull();
  });
});

// ── #14 pinned databases are exempt from LRU eviction ───────────────────────
const DB_LRU_KEY = "dbLru";

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();
  resetOutboxForTests();
  resetRecordCacheForTests();
  resetStore();
  seedUser();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("record cache DB LRU exempts offline pins (#14)", () => {
  it("does not evict a pinned database even past the cache cap", async () => {
    // Two oldest DB tables: one will be pinned, the other is a plain victim.
    cacheReplaceTable(TEST_USER, "props:pinned-db", [
      { id: "p1", value: { id: "p1" } },
    ]);
    cacheReplaceTable(TEST_USER, "props:victim-db", [
      { id: "v1", value: { id: "v1" } },
    ]);
    stampDatabaseCached(TEST_USER, "pinned-db");
    stampDatabaseCached(TEST_USER, "victim-db");
    await recordCacheIdleForTests();
    // A pinned database page id lives in the offline-pin set.
    await setOfflinePin(TEST_USER, "pinned-db", true);

    // Overflow the DB LRU well past the cap so eviction must run.
    for (let i = 0; i < MAX_CACHED_DBS; i += 1) {
      stampDatabaseCached(TEST_USER, `db-${i}`);
    }
    await recordCacheIdleForTests();

    const lru = (await cacheGetMeta<Record<string, number>>(TEST_USER, DB_LRU_KEY)) ?? {};
    // The pinned database survived; the unpinned oldest was evicted.
    expect(Object.keys(lru)).toContain("pinned-db");
    expect(Object.keys(lru)).not.toContain("victim-db");
    // Its cached tables are intact, while the victim's were emptied.
    expect(await cacheListTable(TEST_USER, "props:pinned-db")).toHaveLength(1);
    expect(await cacheListTable(TEST_USER, "props:victim-db")).toHaveLength(0);
  });
});
