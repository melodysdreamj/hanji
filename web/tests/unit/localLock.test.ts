// @vitest-environment jsdom
//
// Local data lock (key custody, roadmap §10): in passphrase mode the durable
// layers wait for an unlock; skipping runs network-only; the wrapped key
// survives sessions and gates all sealed data; enable/disable orchestration
// refuses while offline edits are still queued.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in localLock test.");
    }),
  };
});

import {
  awaitLocalBox,
  lockBoxName,
  localEncryptionMode,
  localLockPending,
  onLocalEncryptionModeChange,
  resetLocalLockForTests,
  setLocalEncryptionMode,
  skipLocalLock,
  unlockLocalData,
} from "@/lib/localLock";
import { legacyLockBoxName } from "@/lib/legacyNamespace";
import {
  outboxAck,
  outboxAllEntries,
  outboxIdleForTests,
  outboxSet,
  resetOutboxForTests,
  type OutboxOp,
} from "@/lib/outbox";
import {
  cacheGetMeta,
  cacheSetMeta,
  recordCacheIdleForTests,
  resetRecordCacheForTests,
} from "@/lib/recordCache";
import {
  disableLocalPassphraseLock,
  enableLocalPassphraseLock,
} from "@/lib/store";
import {
  createIndexedDbOutboxAdapter,
  createPassphraseSecretBox,
  passphraseBoxConfigured,
} from "@edge-base/web";
import { resetStore, seedUser, TEST_USER } from "./components/storeTestUtils";

// __unsafeAllowLowIterations is the SDK's TEST-ONLY escape hatch: it keeps
// PBKDF2 cheap here without weakening the production iteration floor
// (see crypto-box.ts resolveNewIterations).
const FAST = { iterations: 1_000, __unsafeAllowLowIterations: true };

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.indexedDB = new IDBFactory();
  resetStore();
  resetLocalLockForTests();
  resetOutboxForTests();
  resetRecordCacheForTests();
  seedUser();
});

afterEach(() => {
  setLocalEncryptionMode("device");
  resetLocalLockForTests();
});

describe("local lock gate", () => {
  it("moves an old wrapped passphrase key before unlocking under the Hanji name", async () => {
    const legacy = await createPassphraseSecretBox(
      legacyLockBoxName(TEST_USER),
      "correct horse",
      FAST
    );
    expect("error" in legacy).toBe(false);
    setLocalEncryptionMode("passphrase");
    resetLocalLockForTests();

    expect(await unlockLocalData(TEST_USER, "correct horse", FAST)).toBe("ok");
    expect(await passphraseBoxConfigured(lockBoxName(TEST_USER))).toBe(true);
  });

  it("skipped sessions run network-only: caches read empty and write nothing", async () => {
    setLocalEncryptionMode("passphrase");
    resetLocalLockForTests();
    expect(localLockPending(TEST_USER)).toBe(true);

    skipLocalLock(TEST_USER);
    cacheSetMeta(TEST_USER, "probe", { value: 1 });
    await recordCacheIdleForTests();

    expect(await cacheGetMeta(TEST_USER, "probe")).toBeUndefined();
    expect(await outboxAllEntries(TEST_USER)).toEqual([]);
  });

  it("unlocks across sessions with the same passphrase and rejects the wrong one", async () => {
    setLocalEncryptionMode("passphrase");
    resetLocalLockForTests();
    expect(await unlockLocalData(TEST_USER, "correct horse", FAST)).toBe("ok");
    cacheSetMeta(TEST_USER, "probe", { value: "잠금됨" });
    await recordCacheIdleForTests();
    expect(await cacheGetMeta(TEST_USER, "probe")).toEqual({ value: "잠금됨" });

    // New session: layers reset, gate pending again.
    resetLocalLockForTests();
    resetRecordCacheForTests();
    expect(localLockPending(TEST_USER)).toBe(true);
    expect(await unlockLocalData(TEST_USER, "wrong pass", FAST)).toBe("wrong-passphrase");
    expect(await unlockLocalData(TEST_USER, "correct horse", FAST)).toBe("ok");
    expect(await cacheGetMeta(TEST_USER, "probe")).toEqual({ value: "잠금됨" });
  });

  it("a cross-tab mode change unblocks a pending gate and notifies subscribers", async () => {
    setLocalEncryptionMode("passphrase");
    resetLocalLockForTests();
    // Touch the gate so the storage listener is installed and a pending gate
    // exists (this tab is awaiting an unlock decision).
    expect(localLockPending(TEST_USER)).toBe(true);
    let notified = 0;
    const off = onLocalEncryptionModeChange(() => {
      notified += 1;
    });
    const gatePromise = awaitLocalBox(TEST_USER);

    // Another tab flips the encryption mode -> a "storage" event fires here.
    window.dispatchEvent(new StorageEvent("storage", { key: "hanji.encryption.mode" }));

    // The pending gate resolves to null (network-only) instead of wedging the
    // outbox/record-cache getters chained behind it, and subscribers are told
    // to rebuild their key-bound adapters.
    await expect(gatePromise).resolves.toBeNull();
    expect(notified).toBe(1);
    off();
  });

  it("enable refuses while queued changes exist, then succeeds after they drain", async () => {
    // A leftover durable op (e.g. from a dead offline tab) blocks enabling.
    const adapter = createIndexedDbOutboxAdapter<OutboxOp>(`hanji-outbox:${TEST_USER}`);
    if (!adapter) throw new Error("fake-indexeddb adapter unavailable");
    await adapter.put({
      entryKey: "block:b1",
      tabId: "dead-tab",
      updatedAt: 0,
      value: { hintPageId: "p1", id: "b1", kind: "block_update", patch: {} },
    });
    expect(await enableLocalPassphraseLock("longpassphrase")).toBe("pending-changes");

    await adapter.remove("dead-tab", "block:b1");
    expect(await enableLocalPassphraseLock("longpassphrase")).toBe("ok");
    expect(localEncryptionMode()).toBe("passphrase");

    // Layers now run under the unlocked passphrase box without a prompt.
    cacheSetMeta(TEST_USER, "afterEnable", "sealed");
    await recordCacheIdleForTests();
    expect(await cacheGetMeta(TEST_USER, "afterEnable")).toBe("sealed");

    expect(await disableLocalPassphraseLock("wrong")).toBe("wrong-passphrase");
    expect(await disableLocalPassphraseLock("longpassphrase")).toBe("ok");
    expect(localEncryptionMode()).toBe("device");
    // Disable cleared the local caches by design.
    expect(await cacheGetMeta(TEST_USER, "afterEnable")).toBeUndefined();
  });

  it("runs the durable-outbox fallback (no Web Locks) without wedging", async () => {
    // jsdom has no navigator.locks, so withOutboxLock/outboxRekey take the inline
    // fallback. Enabling then disabling must still round-trip, proving the guard
    // for missing Web Locks doesn't crash or block.
    expect((globalThis.navigator as { locks?: unknown }).locks).toBeUndefined();
    expect(await enableLocalPassphraseLock("longpassphrase")).toBe("ok");
    expect(localEncryptionMode()).toBe("passphrase");
    expect(await disableLocalPassphraseLock("longpassphrase")).toBe("ok");
    expect(localEncryptionMode()).toBe("device");
  });

  it("serializes durable writes and the re-key under the one cross-tab lock", async () => {
    // A minimal exclusive LockManager, recording the names it grants. Per-name
    // FIFO mutual exclusion mirrors the real Web Locks contract.
    const granted: string[] = [];
    const tails = new Map<string, Promise<unknown>>();
    const fakeLocks = {
      request(
        name: string,
        _options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" },
        callback: () => Promise<unknown>
      ): Promise<unknown> {
        granted.push(name);
        const prior = tails.get(name) ?? Promise.resolve();
        const run = prior.then(() => callback());
        // Swallow rejections on the tail so one failure can't poison the queue.
        tails.set(name, run.then(
          () => undefined,
          () => undefined
        ));
        return run;
      },
    };
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: fakeLocks,
    });
    try {
      const lockName = `hanji-outbox:${TEST_USER}`;
      // A durable write then its ack must each pass through the shared lock.
      outboxSet(TEST_USER, "block:locked", {
        hintPageId: "p1",
        id: "locked",
        kind: "block_update",
        patch: {},
      });
      outboxAck(TEST_USER, "block:locked");
      await outboxIdleForTests();
      expect(granted.filter((name) => name === lockName).length).toBeGreaterThanOrEqual(2);

      // The re-key migration acquires the SAME lock, so it cannot interleave
      // with a concurrent write.
      const before = granted.filter((name) => name === lockName).length;
      expect(await enableLocalPassphraseLock("longpassphrase")).toBe("ok");
      expect(localEncryptionMode()).toBe("passphrase");
      expect(granted.filter((name) => name === lockName).length).toBeGreaterThan(before);
      // Disable rebuilds the device outbox while the bare lock is already held;
      // namespace migration must use its explicit non-reentrant path.
      expect(await disableLocalPassphraseLock("longpassphrase")).toBe("ok");
      expect(localEncryptionMode()).toBe("device");

      // Namespace migration also holds the SDK sweep lock so a concurrent
      // claimAbandoned() cannot re-key a copied entry before source CAS.
      expect(granted).toContain(`${lockName}::sweep`);
    } finally {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });
});
