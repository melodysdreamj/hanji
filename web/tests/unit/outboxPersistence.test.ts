// @vitest-environment jsdom
//
// Local-first Phase 0 (docs/local-first-roadmap.md): the durable outbox must
// (1) mirror queued mutations into IndexedDB BEFORE the network ack so they
// survive tab close/crash, (2) remove them on ack/terminal drop, and
// (3) replay a dead tab's leftovers in enqueue order on boot with idempotent
// handling of already-landed creates.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in outbox persistence test.");
    }),
    createBlockRemote: vi.fn(async () => undefined),
    createBlocksRemote: vi.fn(async () => []),
    createViewRemote: vi.fn(async () => undefined),
    deleteBlocksRemote: vi.fn(async () => undefined),
    trashPageRemote: vi.fn(async () => []),
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updateBlockRemote: vi.fn(async () => undefined),
  };
});

import {
  createIndexedDbOutboxAdapter,
  createSecretBox,
  encryptOutboxAdapter,
} from "@edge-base/web";
import {
  createBlockRemote,
  createBlocksRemote,
  createViewRemote,
  deleteBlocksRemote,
  trashPageRemote,
  updateBlockRemote,
  updateDatabaseRowRemote,
  updatePageRemote,
} from "@/lib/edgebase";
import { outboxIdleForTests, resetOutboxForTests, type OutboxOp } from "@/lib/outbox";
import { replayDurableOutbox, useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser, TEST_USER } from "./components/storeTestUtils";
import type { Block } from "@/lib/types";

const PAST_RETRY_MS = 2500;
const DB_NAME = `notionlike-outbox:${TEST_USER}`;

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function seedBlock(pageId: string, id: string): Block {
  const now = new Date(0).toISOString();
  const block = {
    id,
    pageId,
    parentId: null,
    type: "paragraph",
    content: { rich: [] },
    plainText: "",
    position: 1,
    createdAt: now,
    updatedAt: now,
    createdBy: TEST_USER,
  } as unknown as Block;
  useStore.setState((s) => ({
    blocksByPage: { ...s.blocksByPage, [pageId]: [block] },
  }));
  return block;
}

async function storedEntries() {
  // Read through the same sealing decorator the app uses; raw plaintext seeds
  // (see seedDeadTabEntry) still pass through, mirroring the migration path.
  const raw = createIndexedDbOutboxAdapter<unknown>(DB_NAME);
  if (!raw) throw new Error("fake-indexeddb adapter unavailable");
  const adapter = encryptOutboxAdapter<OutboxOp>(raw, await createSecretBox(DB_NAME));
  return adapter.listEntries();
}

function seedDeadTabEntry(entryKey: string, value: OutboxOp) {
  const adapter = createIndexedDbOutboxAdapter<OutboxOp>(DB_NAME);
  if (!adapter) throw new Error("fake-indexeddb adapter unavailable");
  return adapter.put({ entryKey, tabId: "dead-tab", updatedAt: 0, value });
}

async function outboxSettled() {
  // Mirror writes ride a FIFO promise chain over real (fake-indexeddb) async
  // work; two rounds let an ack scheduled from a flush land too.
  await outboxIdleForTests();
  await outboxIdleForTests();
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so a mockRejectedValue from one test
  // would leak into the next; re-prime every remote to succeed by default.
  vi.mocked(createBlockRemote).mockResolvedValue(undefined as never);
  vi.mocked(createBlocksRemote).mockResolvedValue([] as never);
  vi.mocked(createViewRemote).mockResolvedValue(undefined as never);
  vi.mocked(deleteBlocksRemote).mockResolvedValue(undefined as never);
  vi.mocked(trashPageRemote).mockResolvedValue([] as never);
  vi.mocked(updateBlockRemote).mockResolvedValue(undefined as never);
  vi.mocked(updateDatabaseRowRemote).mockResolvedValue(undefined as never);
  vi.mocked(updatePageRemote).mockResolvedValue(undefined as never);
  // Fake only the timer functions the retry queues use. Date/setImmediate stay
  // real so fake-indexeddb transactions and Date.now-based seq stamps work.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  globalThis.indexedDB = new IDBFactory();
  resetOutboxForTests();
  resetStore();
  seedUser();
  seedPages([makePage({ id: "p1", title: "Page" })]);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("durable outbox mirroring", () => {
  it("keeps a transient composite block graph as one replayable batch", async () => {
    vi.mocked(createBlocksRemote).mockRejectedValue(new Error("network down"));
    const parent = seedBlock("p1", "batch-parent");
    const child = {
      ...seedBlock("p1", "batch-child"),
      parentId: parent.id,
      position: 1,
    };

    await useStore.getState().persistBlockCreateBatch([parent, child]);
    await outboxSettled();

    const entries = await storedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.value).toMatchObject({
      kind: "remote_call",
      fn: "createBlocksRemote",
      args: [[parent, child]],
    });
  });

  it("keeps a queued block update durable while the network is down", async () => {
    seedBlock("p1", "b1");
    vi.mocked(updateBlockRemote).mockRejectedValue(new Error("network down"));

    useStore.getState().updateBlock("b1", { plainText: "hello" });
    await vi.advanceTimersByTimeAsync(500); // past the 400ms debounce
    await outboxSettled();

    const entries = await storedEntries();
    expect(entries).toHaveLength(1);
    const op = entries[0]!.value;
    expect(op.kind).toBe("block_update");
    if (op.kind === "block_update") {
      expect(op.id).toBe("b1");
      expect(op.hintPageId).toBe("p1");
      expect(op.patch.plainText).toBe("hello");
    }
  });

  it("acks the mirror once the flush succeeds", async () => {
    seedBlock("p1", "b1");

    useStore.getState().updateBlock("b1", { plainText: "hello" });
    // Past the 400ms block debounce AND the 500ms page-touch debounce so both
    // queued mutations flush and ack.
    await vi.advanceTimersByTimeAsync(600);
    await outboxSettled();

    expect(await storedEntries()).toHaveLength(0);
  });

  it("mirrors a block create and clears it on terminal drop without a 409 toast", async () => {
    vi.mocked(createBlockRemote).mockRejectedValue(httpError(409));

    await useStore.getState().createBlock({ pageId: "p1", position: 1 });
    await vi.advanceTimersByTimeAsync(50);
    await outboxSettled();

    // 409 on create = the id already exists server-side (idempotent replay);
    // never a user-facing failure, and the create's mirror entry is released.
    expect(useStore.getState().toasts).toHaveLength(0);
    expect((await storedEntries()).filter((e) => e.entryKey.startsWith("create:"))).toHaveLength(0);
    // Past the page-touch debounce: with every queued mutation flushed the
    // store must be fully drained, and the terminal create never retries.
    await vi.advanceTimersByTimeAsync(PAST_RETRY_MS * 2);
    await outboxSettled();
    expect(await storedEntries()).toHaveLength(0);
    expect(vi.mocked(createBlockRemote)).toHaveBeenCalledTimes(1);
  });
});

describe("durable outbox replay", () => {
  it("replays a dead tab's ops in enqueue order and acks them", async () => {
    const block = seedBlock("p1", "created");
    await seedDeadTabEntry("create:created", { block, kind: "block_create" });
    await seedDeadTabEntry("block:created", {
      hintPageId: "p1",
      id: "created",
      kind: "block_update",
      patch: { plainText: "queued offline" },
    });
    await seedDeadTabEntry("page:elsewhere", {
      id: "elsewhere",
      kind: "page_update",
      patch: { title: "Queued title" },
      target: "page",
    });

    await replayDurableOutbox(TEST_USER);
    await outboxSettled();

    // Creates replay before the updates that depend on them.
    const createOrder = vi.mocked(createBlockRemote).mock.invocationCallOrder[0]!;
    const updateOrder = vi.mocked(updateBlockRemote).mock.invocationCallOrder[0]!;
    expect(createOrder).toBeLessThan(updateOrder);
    expect(vi.mocked(updateBlockRemote)).toHaveBeenCalledWith(
      "created",
      expect.objectContaining({ plainText: "queued offline" }),
      "p1",
      // No expectedUpdatedAt captured for this entry — replay sends the
      // optimistic-concurrency guard only when the enqueue recorded one.
      undefined
    );
    // A page absent from this boot still replays via the routing captured at
    // enqueue time.
    expect(vi.mocked(updatePageRemote)).toHaveBeenCalledWith(
      "elsewhere",
      expect.objectContaining({ title: "Queued title" })
    );
    expect(await storedEntries()).toHaveLength(0);
  });

  it("treats a replayed create that 409s as idempotent success", async () => {
    const block = seedBlock("p1", "landed");
    vi.mocked(createBlockRemote).mockRejectedValue(httpError(409));
    await seedDeadTabEntry("create:landed", { block, kind: "block_create" });

    await replayDurableOutbox(TEST_USER);
    await outboxSettled();

    expect(useStore.getState().toasts).toHaveLength(0);
    expect(await storedEntries()).toHaveLength(0);
  });

  it("keeps a transient one-shot mutation (trash) durable and retains the optimistic state", async () => {
    vi.mocked(trashPageRemote).mockRejectedValue(new Error("network down"));

    await useStore.getState().trashPage("p1");
    await outboxSettled();

    // The optimistic trash sticks locally and the op is durable for replay.
    expect(useStore.getState().pagesById["p1"]?.inTrash).toBe(true);
    const entries = await storedEntries();
    const call = entries.map((e) => e.value).find((op) => op.kind === "remote_call");
    expect(call).toBeDefined();
    if (call?.kind === "remote_call") {
      expect(call.fn).toBe("trashPageRemote");
      expect(call.args).toEqual(["p1"]);
    }
  });

  it("replays a dead tab's remote_call and drops a benign 409 create silently", async () => {
    vi.mocked(createViewRemote).mockRejectedValue(httpError(409));
    await seedDeadTabEntry("call:trash", {
      args: ["p1"],
      fn: "trashPageRemote",
      kind: "remote_call",
    });
    await seedDeadTabEntry("call:view", {
      args: [{ databaseId: "db1", id: "v1" }],
      fn: "createViewRemote",
      kind: "remote_call",
    });
    await seedDeadTabEntry("call:ghost", {
      args: [],
      fn: "noSuchRemoteFn",
      kind: "remote_call",
    });

    await replayDurableOutbox(TEST_USER);
    await outboxSettled();

    expect(vi.mocked(trashPageRemote)).toHaveBeenCalledWith("p1");
    expect(vi.mocked(createViewRemote)).toHaveBeenCalledTimes(1);
    // 409-on-create is idempotent success; the unknown fn is dropped instead
    // of wedging the replay loop; everything drains.
    expect(useStore.getState().toasts).toHaveLength(0);
    expect(await storedEntries()).toHaveLength(0);
  });

  it("keeps a transiently failing replay durable for the next attempt", async () => {
    vi.mocked(updatePageRemote).mockRejectedValue(new Error("network down"));
    await seedDeadTabEntry("page:p9", {
      id: "p9",
      kind: "page_update",
      patch: { title: "Still queued" },
      target: "page",
    });

    await replayDurableOutbox(TEST_USER);
    await outboxSettled();

    // Claimed entries are reassigned durably to this tab before execution, so
    // a transient failure leaves the op on disk for the retry/next boot.
    const entries = await storedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.value.kind).toBe("page_update");
  });
});
