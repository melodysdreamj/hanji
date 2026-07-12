// @vitest-environment jsdom

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DurableOutbox,
  RecordCache,
  createIndexedDbOutboxAdapter,
  createIndexedDbRecordCacheAdapter,
  createPassphraseSecretBox,
  createSecretBox,
  encryptRecordCacheAdapter,
  encryptOutboxAdapter,
  passphraseBoxConfigured,
} from "@edge-base/web";
import {
  clearLegacyBrowserStorage,
  clearLegacyLocalDataOnSignOut,
  clearLegacyOutboxStorage,
  clearLegacyPassphraseKeyStorage,
  clearLegacyRecordCacheStorage,
  LEGACY_OUTBOX_EARLY_META_KEYS,
  LEGACY_RECORD_CACHE_EARLY_META_KEYS,
  LEGACY_HANJI_URI_PREFIX,
  legacyIndexedDbMigrationCanContinue,
  legacyLockBoxName,
  legacyOutboxDatabaseName,
  legacyRecordCacheDatabaseName,
  migrateLegacyBrowserStorage,
  migrateLegacyIndexedDbProvenance,
  normalizeLegacyHanjiClipboardHtml,
  normalizeLegacyHanjiNativeDocument,
  normalizeLegacyHanjiUri,
  readLegacyCompatibleClipboardData,
  type LegacyNamespaceLockManager,
} from "@/lib/legacyNamespace";

const oldNamespace = legacyOutboxDatabaseName("").split("-outbox:", 1)[0];
const FAST_PASSPHRASE = { iterations: 1_000, __unsafeAllowLowIterations: true };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

function openDatabase(
  factory: IDBFactory,
  name: string,
  upgrade?: (database: IDBDatabase) => void,
  version = 1
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version);
    request.onupgradeneeded = () => upgrade?.(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

class SerialNamespaceLocks implements LegacyNamespaceLockManager {
  private readonly held = new Set<string>();
  private readonly waiters = new Map<string, Array<() => void>>();

  isHeld(name: string) {
    return this.held.has(name);
  }

  private async acquire(name: string) {
    if (!this.held.has(name)) {
      this.held.add(name);
      return;
    }
    await new Promise<void>((resolve) => {
      const queue = this.waiters.get(name) ?? [];
      queue.push(resolve);
      this.waiters.set(name, queue);
    });
  }

  private release(name: string) {
    const queue = this.waiters.get(name);
    const next = queue?.shift();
    if (queue?.length === 0) this.waiters.delete(name);
    if (next) next();
    else this.held.delete(name);
  }

  async request<T>(
    name: string,
    options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" },
    callback: (lock: unknown | null) => T | Promise<T>
  ): Promise<T> {
    if (options.ifAvailable && this.held.has(name)) return callback(null);
    await this.acquire(name);
    try {
      return await callback({ name });
    } finally {
      this.release(name);
    }
  }
}

describe("legacy Hanji namespace compatibility", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it("seeds Hanji storage while preserving rolling-window old-tab keys", () => {
    window.localStorage.setItem(`${oldNamespace}:theme`, "dark");
    window.localStorage.setItem(`${oldNamespace}.workspaceId`, "old-workspace");
    window.localStorage.setItem(`${oldNamespace}.encryption.mode`, "passphrase");
    window.localStorage.setItem("hanji.workspaceId", "current-workspace");
    window.sessionStorage.setItem(`${oldNamespace}:pending`, "1");

    migrateLegacyBrowserStorage();

    expect(window.localStorage.getItem("hanji:theme")).toBe("dark");
    expect(window.localStorage.getItem("hanji.workspaceId")).toBe("current-workspace");
    expect(window.localStorage.getItem("hanji.encryption.mode")).toBe("passphrase");
    expect(window.sessionStorage.getItem("hanji:pending")).toBe("1");
    expect(window.localStorage.getItem(`${oldNamespace}:theme`)).toBe("dark");
    expect(window.localStorage.getItem(`${oldNamespace}.encryption.mode`)).toBe("passphrase");
    expect(window.sessionStorage.getItem(`${oldNamespace}:pending`)).toBe("1");
  });

  it("explicit privacy cleanup clears legacy data, keys, and browser storage", async () => {
    const factory = new IDBFactory();
    const userId = "privacy-cleanup";
    const legacyOutboxName = legacyOutboxDatabaseName(userId);
    const legacyOutboxRaw = createIndexedDbOutboxAdapter<unknown>(legacyOutboxName, factory);
    if (!legacyOutboxRaw) throw new Error("fake IndexedDB unavailable");
    const legacyOutbox = encryptOutboxAdapter<{ private: boolean }>(
      legacyOutboxRaw,
      await createSecretBox(legacyOutboxName, { factory })
    );
    await legacyOutbox.put({
      entryKey: "private",
      tabId: "signed-out-tab",
      updatedAt: 1,
      value: { private: true },
    });
    const legacyRecordsName = legacyRecordCacheDatabaseName(userId);
    const legacyRecords = createIndexedDbRecordCacheAdapter(legacyRecordsName, factory);
    if (!legacyRecords) throw new Error("fake IndexedDB unavailable");
    await createSecretBox(legacyRecordsName, { factory });
    await legacyRecords.setMeta("private", { private: true });
    const legacyPassphraseName = legacyLockBoxName(userId);
    const passphrase = await createPassphraseSecretBox(
      legacyPassphraseName,
      "private passphrase",
      { ...FAST_PASSPHRASE, factory }
    );
    if ("error" in passphrase) throw new Error("passphrase box unavailable");
    window.localStorage.setItem(`${oldNamespace}.encryption.mode`, "passphrase");
    window.sessionStorage.setItem(`${oldNamespace}:private`, "1");

    await Promise.all([
      clearLegacyOutboxStorage(userId, factory),
      clearLegacyRecordCacheStorage(userId, factory),
    ]);
    await clearLegacyPassphraseKeyStorage(userId, factory);
    clearLegacyBrowserStorage();

    await expect(legacyOutboxRaw.listEntries()).resolves.toEqual([]);
    await expect(legacyRecords.getMeta("private")).resolves.toBeUndefined();
    await expect(passphraseBoxConfigured(legacyPassphraseName, factory)).resolves.toBe(false);
    expect(window.localStorage.getItem(`${oldNamespace}.encryption.mode`)).toBeNull();
    expect(window.sessionStorage.getItem(`${oldNamespace}:private`)).toBeNull();
    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyOutboxName}::keys`,
          canonicalName: `hanji-outbox:${userId}::keys`,
        },
        [{ legacyName: legacyOutboxName, canonicalName: `hanji-outbox:${userId}` }],
        factory
      )
    ).resolves.toBe("not-needed");
  });

  it("sign-out cleanup wins a concurrent legacy migration under the shared locks", async () => {
    const factory = new IDBFactory();
    const userId = "signout-race";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = encryptOutboxAdapter<{ private: boolean }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacy.put({
      entryKey: "private",
      tabId: "dead-tab",
      updatedAt: 1,
      value: { private: true },
    });
    const locks = new SerialNamespaceLocks();
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: locks,
    });
    let releaseRecheck!: () => void;
    const recheckGate = new Promise<void>((resolve) => {
      releaseRecheck = resolve;
    });
    let copied!: () => void;
    const copiedSignal = new Promise<void>((resolve) => {
      copied = resolve;
    });
    try {
      const migration = migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeStores: ["entries"],
            respectLegacyOutboxLiveness: true,
          },
        ],
        factory,
        {
          beforeProvenanceRecheckForTest: async () => {
            copied();
            await recheckGate;
          },
          exclusiveLockName: canonicalName,
          locks,
        }
      );
      await copiedSignal;
      const cleanup = clearLegacyLocalDataOnSignOut(userId, factory);
      releaseRecheck();
      await expect(migration).resolves.toBe("migrated");
      await expect(cleanup).resolves.toBe(true);

      await expect(legacyRaw.listEntries()).resolves.toEqual([]);
      const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
      if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
      await expect(canonicalRaw.listEntries()).resolves.toEqual([]);
      await expect(
        migrateLegacyIndexedDbProvenance(
          {
            legacyName: `${legacyName}::keys`,
            canonicalName: `${canonicalName}::keys`,
          },
          [{ legacyName, canonicalName }],
          factory
        )
      ).resolves.toBe("not-needed");
    } finally {
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });

  it("keeps a canonical sweep from recreating outbox data after sign-out", async () => {
    const factory = new IDBFactory();
    const userId = "signout-sweep";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!legacyRaw || !canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await legacyRaw.put({
      entryKey: "legacy-private",
      tabId: "old-tab",
      updatedAt: 1,
      value: { private: true },
    });
    await canonicalRaw.put({
      entryKey: "canonical-private",
      tabId: "dead-hanji-tab",
      updatedAt: 2,
      value: { private: true },
    });
    const locks = new SerialNamespaceLocks();
    const canonical = new DurableOutbox<unknown>({
      adapter: canonicalRaw,
      locks,
      name: canonicalName,
      tabId: "current-hanji-tab",
    });
    Object.defineProperty(globalThis.navigator, "locks", {
      configurable: true,
      value: locks,
    });
    let releaseLegacyLock!: () => void;
    const legacyGate = new Promise<void>((resolve) => {
      releaseLegacyLock = resolve;
    });
    let signalLegacyHeld!: () => void;
    const legacyHeld = new Promise<void>((resolve) => {
      signalLegacyHeld = resolve;
    });
    const blocker = locks.request(legacyName, { mode: "exclusive" }, async () => {
      signalLegacyHeld();
      await legacyGate;
    });
    await legacyHeld;

    try {
      const cleanup = clearLegacyLocalDataOnSignOut(userId, factory);
      await vi.waitFor(() => {
        expect(locks.isHeld(`${canonicalName}::sweep`)).toBe(true);
      });
      let claimSettled = false;
      const claim = canonical.claimAbandoned().finally(() => {
        claimSettled = true;
      });
      await Promise.resolve();
      expect(claimSettled).toBe(false);

      releaseLegacyLock();
      await blocker;
      await expect(cleanup).resolves.toBe(true);
      await expect(claim).resolves.toEqual([]);
      await expect(canonicalRaw.listEntries()).resolves.toEqual([]);
      await expect(legacyRaw.listEntries()).resolves.toEqual([]);
    } finally {
      releaseLegacyLock();
      delete (globalThis.navigator as { locks?: unknown }).locks;
    }
  });

  it("reads old clipboard/URI/HTML/native aliases but normalizes every result to Hanji", () => {
    const oldMime = `application/x-${oldNamespace}-blocks`;
    const data = {
      getData: vi.fn((type: string) => (type === oldMime ? "old-blocks" : "")),
    } as unknown as DataTransfer;

    expect(readLegacyCompatibleClipboardData(data, "application/x-hanji-blocks")).toBe(
      "old-blocks"
    );
    expect(normalizeLegacyHanjiUri(`${LEGACY_HANJI_URI_PREFIX}page/old`)).toBe(
      "hanji://page/old"
    );
    expect(
      normalizeLegacyHanjiClipboardHtml(`<div data-${oldNamespace}-copy="true"></div>`)
    ).toBe('<div data-hanji-copy="true"></div>');
    expect(
      normalizeLegacyHanjiNativeDocument({
        format: ["ink", "line.export"].join(""),
        entities: { pages: [] },
      })
    ).toMatchObject({ format: "hanji.export" });
  });

  it("preserves canonical conflicts and copies complete schemas with out-of-line keys", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("migration-test");
    const canonicalName = "hanji-outbox:migration-test";
    const legacy = await openDatabase(factory, legacyName, (database) => {
      const entries = database.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("byTab", "tabId");
      database.createObjectStore("meta");
      database.createObjectStore("auto", { autoIncrement: true });
    });
    {
      const transaction = legacy.transaction(["entries", "meta", "auto"], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "same", tabId: "old", value: "old" });
      transaction
        .objectStore("entries")
        .put({ key: "legacy-only", tabId: "old", value: "legacy" });
      transaction.objectStore("meta").put(9, "seq");
      transaction.objectStore("auto").put({ value: "explicit-key" }, 7);
      await done;
    }
    legacy.close();

    const canonical = await openDatabase(factory, canonicalName, (database) => {
      const entries = database.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("byTab", "tabId");
      database.createObjectStore("meta");
      database.createObjectStore("auto", { autoIncrement: true });
    });
    {
      const transaction = canonical.transaction("entries", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "same", tabId: "new", value: "current" });
      transaction
        .objectStore("entries")
        .put({ key: "canonical-only", tabId: "new", value: "canonical" });
      await done;
    }
    canonical.close();

    await migrateLegacyIndexedDbProvenance(
      {
        legacyName: `${legacyName}::keys`,
        canonicalName: `${canonicalName}::keys`,
      },
      [{ legacyName, canonicalName }],
      factory
    );

    const migrated = await openDatabase(factory, canonicalName);
    expect(Array.from(migrated.objectStoreNames)).toEqual(["auto", "entries", "meta"]);
    const transaction = migrated.transaction(["auto", "entries", "meta"], "readonly");
    const done = transactionDone(transaction);
    const [entries, seq, explicit] = await Promise.all([
      requestResult(transaction.objectStore("entries").getAll()),
      requestResult(transaction.objectStore("meta").get("seq")),
      requestResult(transaction.objectStore("auto").get(7)),
    ]);
    await done;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "same", value: "current" }),
        expect.objectContaining({ key: "canonical-only", value: "canonical" }),
        expect.objectContaining({ key: "legacy-only", value: "legacy" }),
      ])
    );
    expect(migrated.transaction("entries").objectStore("entries").indexNames.contains("byTab"))
      .toBe(true);
    expect(seq).toBe(9);
    expect(explicit).toEqual({ value: "explicit-key" });
    migrated.close();
  });

  it("merges into a compatible higher-version canonical database", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("future-version");
    const canonicalName = "hanji-outbox:future-version";
    const makeSchema = (database: IDBDatabase) => {
      const entries = database.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("byTab", "tabId");
      database.createObjectStore("meta");
    };
    const legacy = await openDatabase(factory, legacyName, makeSchema);
    {
      const transaction = legacy.transaction("entries", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "legacy", tabId: "old" });
      await done;
    }
    legacy.close();
    const canonical = await openDatabase(factory, canonicalName, makeSchema, 2);
    {
      const transaction = canonical.transaction("entries", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "canonical", tabId: "new" });
      await done;
    }
    canonical.close();

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory
      )
    ).resolves.toBe("migrated");
    const migrated = await openDatabase(factory, canonicalName, undefined, 2);
    expect(migrated.version).toBe(2);
    await expect(
      requestResult(migrated.transaction("entries").objectStore("entries").getAll())
    ).resolves.toEqual(
      expect.arrayContaining([
        { key: "canonical", tabId: "new" },
        { key: "legacy", tabId: "old" },
      ])
    );
    migrated.close();
  });

  it("seeds canonical outbox seq before a later entry batch fails", async () => {
    const factory = new IDBFactory();
    const userId = "chunked-outbox";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    await createSecretBox(legacyName, { factory });
    for (let index = 0; index < 300; index += 1) {
      await legacyRaw.put({
        entryKey: `op-${String(index).padStart(4, "0")}`,
        tabId: "old-tab",
        updatedAt: index,
        value: { index },
      });
    }
    const locks = new SerialNamespaceLocks();

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeStores: ["entries"],
            earlyMetaKeys: LEGACY_OUTBOX_EARLY_META_KEYS,
            respectLegacyOutboxLiveness: true,
          },
        ],
        factory,
        {
          beforeDataBatchMergeForTest: async (storeName, batchIndex) => {
            if (storeName === "entries" && batchIndex === 1) {
              throw new DOMException("quota", "QuotaExceededError");
            }
          },
          exclusiveLockName: canonicalName,
          locks,
        }
      )
    ).rejects.toThrow("Legacy IndexedDB migration was deferred");

    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await expect(canonicalRaw.listEntries()).resolves.toHaveLength(128);
    await expect(legacyRaw.listEntries()).resolves.toHaveLength(172);
    await canonicalRaw.put({
      entryKey: "hanji-after-partial-move",
      tabId: "hanji-tab",
      updatedAt: 301,
      value: { source: "hanji" },
    });
    await expect(canonicalRaw.listEntries("hanji-tab")).resolves.toEqual([
      expect.objectContaining({ entryKey: "hanji-after-partial-move", seq: 301 }),
    ]);

    const legacyDatabase = await openDatabase(factory, legacyName);
    await expect(
      requestResult(legacyDatabase.transaction("meta").objectStore("meta").get("seq"))
    ).resolves.toBe(300);
    legacyDatabase.close();
  });

  it("moves an outbox replay prefix even when primary keys sort in reverse causal order", async () => {
    const factory = new IDBFactory();
    const userId = "sequence-prefix";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    await createSecretBox(legacyName, { factory });
    await legacyRaw.put({
      entryKey: "z-create",
      tabId: "old-tab",
      updatedAt: 1,
      value: { kind: "create" },
    });
    for (let sequence = 2; sequence <= 129; sequence += 1) {
      await legacyRaw.put({
        entryKey: `a-update-${String(sequence).padStart(4, "0")}`,
        tabId: "old-tab",
        updatedAt: sequence,
        value: { kind: "update", sequence },
      });
    }
    let failure: unknown;
    try {
      await migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeStores: ["entries"],
            earlyMetaKeys: LEGACY_OUTBOX_EARLY_META_KEYS,
            respectLegacyOutboxLiveness: true,
          },
        ],
        factory,
        {
          beforeDataBatchMergeForTest: async (storeName, batchIndex) => {
            if (storeName === "entries" && batchIndex === 1) {
              throw new DOMException("quota", "QuotaExceededError");
            }
          },
          exclusiveLockName: canonicalName,
          locks: new SerialNamespaceLocks(),
        }
      );
    } catch (error) {
      failure = error;
    }
    expect(legacyIndexedDbMigrationCanContinue(failure)).toBe(true);

    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalEntries = await canonicalRaw.listEntries();
    expect(canonicalEntries).toHaveLength(128);
    expect(canonicalEntries[0]).toEqual(
      expect.objectContaining({ entryKey: "z-create", seq: 1 })
    );
    expect(canonicalEntries.at(-1)?.seq).toBe(128);
    await expect(legacyRaw.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "a-update-0129", seq: 129 }),
    ]);
  });

  it("moves a large record cache in bounded cursor batches and skips empty re-entry", async () => {
    const factory = new IDBFactory();
    const userId = "chunked-records";
    const legacyName = legacyRecordCacheDatabaseName(userId);
    const canonicalName = `hanji-records:${userId}`;
    const legacyRaw = createIndexedDbRecordCacheAdapter(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptRecordCacheAdapter(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    const legacy = new RecordCache({ adapter: legacyAdapter, name: legacyName, schemaVersion: 2 });
    const records = Array.from({ length: 600 }, (_, index) => ({
      id: `record-${String(index).padStart(4, "0")}`,
      value: { payload: "x".repeat(512) },
    }));
    await legacy.putRecords("pages", records);
    await legacy.setMeta("bootstrap", { count: records.length });
    const locks = new SerialNamespaceLocks();
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const pair = {
      legacyName,
      canonicalName,
      consumeCanonicalConflicts: true,
      consumeStores: ["records", "meta"],
      earlyMetaKeys: LEGACY_RECORD_CACHE_EARLY_META_KEYS,
      requireExclusiveLock: true,
    } as const;
    const originalGetAll = IDBObjectStore.prototype.getAll;
    const originalGetAllKeys = IDBObjectStore.prototype.getAllKeys;
    const originalOpenCursor = IDBObjectStore.prototype.openCursor;
    let recordCursorCalls = 0;
    const getAllSpy = vi
      .spyOn(IDBObjectStore.prototype, "getAll")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === "records" || this.name === "meta") {
          throw new Error("unbounded data-store getAll is forbidden");
        }
        return Reflect.apply(originalGetAll, this, args);
      });
    const getAllKeysSpy = vi
      .spyOn(IDBObjectStore.prototype, "getAllKeys")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === "records" || this.name === "meta") {
          throw new Error("unbounded data-store getAllKeys is forbidden");
        }
        return Reflect.apply(originalGetAllKeys, this, args);
      });
    const cursorSpy = vi
      .spyOn(IDBObjectStore.prototype, "openCursor")
      .mockImplementation(function (this: IDBObjectStore, ...args) {
        if (this.name === "records") recordCursorCalls += 1;
        return Reflect.apply(originalOpenCursor, this, args);
      });
    try {
      await expect(
        migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
          exclusiveLockName: `hanji-outbox:${userId}`,
          locks,
        })
      ).resolves.toBe("migrated");
      expect(recordCursorCalls).toBeGreaterThan(1);
      await expect(legacyRaw.listTable("pages")).resolves.toEqual([]);
      await expect(legacyRaw.getMeta("bootstrap")).resolves.toBeUndefined();
      const canonicalRaw = createIndexedDbRecordCacheAdapter(canonicalName, factory);
      if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
      const canonicalAdapter = encryptRecordCacheAdapter(
        canonicalRaw,
        await createSecretBox(canonicalName, { factory })
      );
      const canonical = new RecordCache({
        adapter: canonicalAdapter,
        name: canonicalName,
        schemaVersion: 2,
      });
      await expect(canonical.listTable("pages")).resolves.toHaveLength(records.length);
      await expect(canonical.getMeta("bootstrap")).resolves.toEqual({ count: records.length });
      await expect(legacyAdapter.getMeta("__recordCacheSchemaVersion")).resolves.toBe(2);

      recordCursorCalls = 0;
      await expect(
        migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
          exclusiveLockName: `hanji-outbox:${userId}`,
          locks,
        })
      ).resolves.toBe("migrated");
      expect(recordCursorCalls).toBe(0);
    } finally {
      getAllSpy.mockRestore();
      getAllKeysSpy.mockRestore();
      cursorSpy.mockRestore();
    }
  });

  it("backs off quota-limited batches and consumes each successful subbatch", async () => {
    const factory = new IDBFactory();
    const userId = "quota-backoff";
    const legacyName = legacyRecordCacheDatabaseName(userId);
    const canonicalName = `hanji-records:${userId}`;
    const legacyRaw = createIndexedDbRecordCacheAdapter(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptRecordCacheAdapter(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    const legacy = new RecordCache({
      adapter: legacyAdapter,
      name: legacyName,
      schemaVersion: 2,
    });
    const records = Array.from({ length: 257 }, (_, index) => ({
      id: `record-${String(index).padStart(4, "0")}`,
      value: { payload: "near-quota" },
    }));
    await legacy.putRecords("pages", records);
    const attemptedSizes: number[] = [];

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeCanonicalConflicts: true,
            consumeStores: ["records", "meta"],
            earlyMetaKeys: LEGACY_RECORD_CACHE_EARLY_META_KEYS,
            requireExclusiveLock: true,
          },
        ],
        factory,
        {
          beforeDataBatchMergeForTest: async (storeName, _batchIndex, batchSize) => {
            if (storeName !== "records") return;
            attemptedSizes.push(batchSize);
            if (batchSize > 16) throw new DOMException("quota", "QuotaExceededError");
          },
          exclusiveLockName: `hanji-outbox:${userId}`,
          locks: new SerialNamespaceLocks(),
        }
      )
    ).resolves.toBe("migrated");

    expect(attemptedSizes).toEqual(expect.arrayContaining([128, 64, 32, 16]));
    await expect(legacyRaw.listTable("pages")).resolves.toEqual([]);
    const canonicalRaw = createIndexedDbRecordCacheAdapter(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonical = new RecordCache({
      adapter: encryptRecordCacheAdapter(
        canonicalRaw,
        await createSecretBox(canonicalName, { factory })
      ),
      name: canonicalName,
      schemaVersion: 2,
    });
    await expect(canonical.listTable("pages")).resolves.toHaveLength(records.length);
  });

  it("seeds the record schema before a no-lock defer and resumes when locks return", async () => {
    const factory = new IDBFactory();
    const userId = "locks-return";
    const legacyName = legacyRecordCacheDatabaseName(userId);
    const canonicalName = `hanji-records:${userId}`;
    const legacyRaw = createIndexedDbRecordCacheAdapter(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = new RecordCache({
      adapter: encryptRecordCacheAdapter(
        legacyRaw,
        await createSecretBox(legacyName, { factory })
      ),
      name: legacyName,
      schemaVersion: 2,
    });
    await legacy.putRecords("pages", [{ id: "legacy", value: { title: "preserved" } }]);
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const pair = {
      legacyName,
      canonicalName,
      consumeCanonicalConflicts: true,
      consumeStores: ["records", "meta"],
      earlyMetaKeys: LEGACY_RECORD_CACHE_EARLY_META_KEYS,
      requireExclusiveLock: true,
    } as const;

    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, { locks: null })
    ).resolves.toBe("preserved-conflict");
    await expect(legacy.listTable("pages")).resolves.toHaveLength(1);
    const canonicalRaw = createIndexedDbRecordCacheAdapter(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalBeforeLocks = new RecordCache({
      adapter: encryptRecordCacheAdapter(
        canonicalRaw,
        await createSecretBox(canonicalName, { factory })
      ),
      name: canonicalName,
      schemaVersion: 2,
    });
    await expect(canonicalBeforeLocks.getMeta("__recordCacheSchemaVersion")).resolves.toBe(2);
    await expect(canonicalBeforeLocks.listTable("pages")).resolves.toEqual([]);

    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
        exclusiveLockName: `hanji-outbox:${userId}`,
        locks: new SerialNamespaceLocks(),
      })
    ).resolves.toBe("migrated");
    const canonicalAfterLocks = new RecordCache({
      adapter: encryptRecordCacheAdapter(
        canonicalRaw,
        await createSecretBox(canonicalName, { factory })
      ),
      name: canonicalName,
      schemaVersion: 2,
    });
    await expect(canonicalAfterLocks.listTable("pages")).resolves.toEqual([
      { id: "legacy", value: { title: "preserved" } },
    ]);
    await expect(legacyRaw.listTable("pages")).resolves.toEqual([]);
  });

  it("keeps cache metadata in legacy when a later record batch fails", async () => {
    const factory = new IDBFactory();
    const userId = "chunk-failure";
    const legacyName = legacyRecordCacheDatabaseName(userId);
    const canonicalName = `hanji-records:${userId}`;
    const legacyRaw = createIndexedDbRecordCacheAdapter(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptRecordCacheAdapter(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    const legacy = new RecordCache({ adapter: legacyAdapter, name: legacyName, schemaVersion: 2 });
    const records = Array.from({ length: 300 }, (_, index) => ({
      id: `record-${String(index).padStart(4, "0")}`,
      value: { payload: "private" },
    }));
    await legacy.putRecords("pages", records);
    await legacy.setMeta("bootstrap", { complete: true });
    const locks = new SerialNamespaceLocks();

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeCanonicalConflicts: true,
            consumeStores: ["records", "meta"],
            earlyMetaKeys: LEGACY_RECORD_CACHE_EARLY_META_KEYS,
            requireExclusiveLock: true,
          },
        ],
        factory,
        {
          beforeDataBatchMergeForTest: async (storeName, batchIndex) => {
            if (storeName === "records" && batchIndex === 1) {
              throw new DOMException("quota", "QuotaExceededError");
            }
          },
          exclusiveLockName: `hanji-outbox:${userId}`,
          locks,
        }
      )
    ).rejects.toThrow("Legacy IndexedDB migration was deferred");

    const canonicalRaw = createIndexedDbRecordCacheAdapter(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalAdapter = encryptRecordCacheAdapter(
      canonicalRaw,
      await createSecretBox(canonicalName, { factory })
    );
    const canonical = new RecordCache({
      adapter: canonicalAdapter,
      name: canonicalName,
      schemaVersion: 2,
    });
    // This is the real SDK bootstrap path: without the early schema marker,
    // ensureSchema() would clear the 128 already-moved records here.
    await expect(canonical.listTable("pages")).resolves.toHaveLength(128);
    await expect(canonicalRaw.getMeta("bootstrap")).resolves.toBeUndefined();
    await expect(legacyRaw.listTable("pages")).resolves.toHaveLength(172);
    await expect(legacy.getMeta("bootstrap")).resolves.toEqual({ complete: true });
    await expect(legacy.getMeta("__recordCacheSchemaVersion")).resolves.toBe(2);
  });

  it("preserves both databases instead of delete-rebuilding a partial canonical target", async () => {
    const factory = new IDBFactory();
    const deleteSpy = vi.spyOn(factory, "deleteDatabase");
    const legacyName = legacyOutboxDatabaseName("partial-target");
    const canonicalName = "hanji-outbox:partial-target";
    const legacy = await openDatabase(factory, legacyName, (database) => {
      const entries = database.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("byTab", "tabId");
      database.createObjectStore("meta");
    });
    {
      const transaction = legacy.transaction(["entries", "meta"], "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "legacy", tabId: "old" });
      transaction.objectStore("meta").put(7, "seq");
      await done;
    }
    legacy.close();
    const canonical = await openDatabase(factory, canonicalName, (database) => {
      const entries = database.createObjectStore("entries", { keyPath: "key" });
      entries.createIndex("byTab", "tabId");
    });
    {
      const transaction = canonical.transaction("entries", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("entries").put({ key: "canonical", tabId: "new" });
      await done;
    }
    canonical.close();

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory
      )
    ).resolves.toBe("preserved-conflict");

    const preservedCanonical = await openDatabase(factory, canonicalName);
    expect(Array.from(preservedCanonical.objectStoreNames)).toEqual(["entries"]);
    await expect(
      requestResult(preservedCanonical.transaction("entries").objectStore("entries").getAll())
    ).resolves.toEqual([{ key: "canonical", tabId: "new" }]);
    preservedCanonical.close();
    const preservedLegacy = await openDatabase(factory, legacyName);
    expect(Array.from(preservedLegacy.objectStoreNames)).toEqual(["entries", "meta"]);
    await expect(
      requestResult(preservedLegacy.transaction("entries").objectStore("entries").getAll())
    ).resolves.toEqual([{ key: "legacy", tabId: "old" }]);
    preservedLegacy.close();
    expect(deleteSpy).not.toHaveBeenCalledWith(canonicalName);
  });

  it("closes a late database handle after a blocked open already failed", async () => {
    const factory = new IDBFactory();
    const legacyKeyName = `${legacyOutboxDatabaseName("blocked-open")}::keys`;
    const keyDatabase = await openDatabase(factory, legacyKeyName, (database) => {
      database.createObjectStore("keys");
    });
    {
      const transaction = keyDatabase.transaction("keys", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("keys").put("legacy-key", "active");
      await done;
    }
    keyDatabase.close();

    const originalOpen = factory.open.bind(factory);
    let injected = false;
    let lateRequest: IDBOpenDBRequest | null = null;
    let lateSuccess!: Promise<void>;
    vi.spyOn(factory, "open").mockImplementation(((name: string, version?: number) => {
      const request = version === undefined ? originalOpen(name) : originalOpen(name, version);
      if (name === legacyKeyName && !injected) {
        injected = true;
        lateRequest = request;
        lateSuccess = new Promise((resolve) => {
          request.addEventListener("success", () => resolve(), { once: true });
        });
        queueMicrotask(() => {
          request.onblocked?.call(
            request,
            new Event("blocked") as unknown as IDBVersionChangeEvent
          );
        });
      }
      return request;
    }) as IDBFactory["open"]);

    await expect(
      migrateLegacyIndexedDbProvenance(
        { legacyName: legacyKeyName, canonicalName: "hanji-outbox:blocked-open::keys" },
        [],
        factory
      )
    ).rejects.toThrow("Legacy IndexedDB migration was deferred");
    await lateSuccess;
    const lateDatabase = (lateRequest as unknown as IDBOpenDBRequest).result;
    expect(() => lateDatabase.transaction("keys", "readonly")).toThrowError(
      expect.objectContaining({ name: "InvalidStateError" })
    );
  });

  it("moves the device key before encrypted outbox bytes so old queued work stays readable", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("encrypted-migration");
    const canonicalName = "hanji-outbox:encrypted-migration";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyBox = await createSecretBox(legacyName, { factory });
    const legacyAdapter = encryptOutboxAdapter<{ kind: string }>(legacyRaw, legacyBox);
    await legacyAdapter.put({
      entryKey: "queued",
      tabId: "old-tab",
      updatedAt: 1,
      value: { kind: "page_update" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory
      )
    ).resolves.toBe("migrated");

    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalBox = await createSecretBox(canonicalName, { factory });
    const canonicalAdapter = encryptOutboxAdapter<{ kind: string }>(canonicalRaw, canonicalBox);
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({
        entryKey: "queued",
        value: { kind: "page_update" },
      }),
    ]);
  });

  it("serializes a canonical sweep across merge and source consume", async () => {
    const factory = new IDBFactory();
    const userId = "canonical-sweep";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!legacyRaw || !canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = encryptOutboxAdapter<{ kind: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacy.put({
      entryKey: "queued",
      tabId: "old-tab",
      updatedAt: 1,
      value: { kind: "page_update" },
    });
    const locks = new SerialNamespaceLocks();
    const canonical = new DurableOutbox<unknown>({
      adapter: canonicalRaw,
      locks,
      name: canonicalName,
      tabId: "hanji-tab",
    });
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const pair = {
      legacyName,
      canonicalName,
      consumeStores: ["entries"],
      earlyMetaKeys: LEGACY_OUTBOX_EARLY_META_KEYS,
      respectLegacyOutboxLiveness: true,
    } as const;
    let claimSettled = false;
    let claimPromise: Promise<Awaited<ReturnType<typeof canonical.claimAbandoned>>> | null = null;

    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
        beforeProvenanceRecheckForTest: async () => {
          claimPromise = canonical.claimAbandoned().finally(() => {
            claimSettled = true;
          });
          await Promise.resolve();
          expect(claimSettled).toBe(false);
        },
        exclusiveLockName: canonicalName,
        locks,
      })
    ).resolves.toBe("migrated");

    if (!claimPromise) throw new Error("claim did not start");
    await expect(claimPromise).resolves.toEqual([
      expect.objectContaining({ entryKey: "queued", tabId: "hanji-tab" }),
    ]);
    await expect(legacy.listEntries()).resolves.toEqual([]);
    await canonical.ack("queued");
    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
        exclusiveLockName: canonicalName,
        locks,
      })
    ).resolves.toBe("migrated");
    await expect(canonical.claimAbandoned()).resolves.toEqual([]);
  });

  it("serializes a legacy sweep across source consume", async () => {
    const factory = new IDBFactory();
    const userId = "legacy-sweep";
    const legacyName = legacyOutboxDatabaseName(userId);
    const canonicalName = `hanji-outbox:${userId}`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = encryptOutboxAdapter<{ kind: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacy.put({
      entryKey: "queued",
      tabId: "dead-old-tab",
      updatedAt: 1,
      value: { kind: "page_update" },
    });
    const locks = new SerialNamespaceLocks();
    const legacyClaimant = new DurableOutbox<unknown>({
      adapter: legacyRaw,
      locks,
      name: legacyName,
      tabId: "old-claimant-tab",
    });
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const pair = {
      legacyName,
      canonicalName,
      consumeStores: ["entries"],
      earlyMetaKeys: LEGACY_OUTBOX_EARLY_META_KEYS,
      respectLegacyOutboxLiveness: true,
    } as const;
    let claimSettled = false;
    let claimPromise: Promise<Awaited<ReturnType<typeof legacyClaimant.claimAbandoned>>> | null =
      null;

    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, [pair], factory, {
        beforeProvenanceRecheckForTest: async () => {
          claimPromise = legacyClaimant.claimAbandoned().finally(() => {
            claimSettled = true;
          });
          await Promise.resolve();
          expect(claimSettled).toBe(false);
        },
        exclusiveLockName: canonicalName,
        locks,
      })
    ).resolves.toBe("migrated");

    if (!claimPromise) throw new Error("legacy claim did not start");
    await expect(claimPromise).resolves.toEqual([]);
    await expect(legacyRaw.listEntries()).resolves.toEqual([]);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await expect(canonicalRaw.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "queued", tabId: "dead-old-tab" }),
    ]);
  });

  it("recovers a late old-tab write on the next pass without whole-DB deletion", async () => {
    const factory = new IDBFactory();
    const deleteSpy = vi.spyOn(factory, "deleteDatabase");
    const legacyName = legacyOutboxDatabaseName("late-write");
    const canonicalName = "hanji-outbox:late-write";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ value: number }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "first",
      tabId: "old-tab",
      updatedAt: 1,
      value: { value: 1 },
    });
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const dataPairs = [
      { legacyName, canonicalName, consumeStores: ["entries"] },
    ] as const;

    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, dataPairs, factory)
    ).resolves.toBe("migrated");
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalAdapter = encryptOutboxAdapter<{ value: number }>(
      canonicalRaw,
      await createSecretBox(canonicalName, { factory })
    );
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "first", value: { value: 1 } }),
    ]);
    await expect(legacyAdapter.listEntries()).resolves.toEqual([]);

    // An already-open old tab rewrites the same composite outbox key after the
    // first migration. The next pass must keep the newer outer timestamp and
    // consume only the exact legacy snapshot it actually copied.
    await legacyAdapter.put({
      entryKey: "first",
      tabId: "old-tab",
      updatedAt: 2,
      value: { value: 2 },
    });
    await expect(
      migrateLegacyIndexedDbProvenance(keyPair, dataPairs, factory)
    ).resolves.toBe("migrated");
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "first", value: { value: 2 } }),
    ]);
    await expect(legacyAdapter.listEntries()).resolves.toEqual([]);
    expect(deleteSpy).not.toHaveBeenCalledWith(legacyName);
    expect(deleteSpy).not.toHaveBeenCalledWith(`${legacyName}::keys`);
  });

  it("skips a live old tab until its legacy liveness lock becomes available", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("live-old-tab");
    const canonicalName = "hanji-outbox:live-old-tab";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "live",
      tabId: "live-tab",
      updatedAt: 1,
      value: { source: "live" },
    });
    await legacyAdapter.put({
      entryKey: "dead",
      tabId: "dead-tab",
      updatedAt: 1,
      value: { source: "dead" },
    });
    const liveLockName = `${legacyName}::tab::live-tab`;
    const held = new Set([liveLockName]);
    const requested: string[] = [];
    const locks: LegacyNamespaceLockManager = {
      async request(name, options, callback) {
        requested.push(name);
        return callback(options.ifAvailable && held.has(name) ? null : {});
      },
    };
    const pair = {
      legacyName,
      canonicalName,
      consumeStores: ["entries"],
      respectLegacyOutboxLiveness: true,
    } as const;
    const options = { exclusiveLockName: canonicalName, locks };

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [pair],
        factory,
        options
      )
    ).resolves.toBe("preserved-conflict");
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const canonicalAdapter = encryptOutboxAdapter<{ source: string }>(
      canonicalRaw,
      await createSecretBox(canonicalName, { factory })
    );
    // The live tab owns seq=1, so seq=2 must not overtake it even though the
    // later entry's dead-tab lock is available.
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([]);
    await expect(legacyAdapter.listEntries()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryKey: "live", value: { source: "live" } }),
        expect.objectContaining({ entryKey: "dead", value: { source: "dead" } }),
      ])
    );
    expect(requested).toEqual(
      expect.arrayContaining([canonicalName, legacyName, liveLockName])
    );
    expect(requested.slice(0, 4)).toEqual([
      canonicalName,
      `${canonicalName}::sweep`,
      legacyName,
      `${legacyName}::sweep`,
    ]);

    held.clear();
    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [pair],
        factory,
        options
      )
    ).resolves.toBe("migrated");
    await expect(canonicalAdapter.listEntries()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entryKey: "dead", value: { source: "dead" } }),
        expect.objectContaining({ entryKey: "live", value: { source: "live" } }),
      ])
    );
    await expect(legacyAdapter.listEntries()).resolves.toEqual([]);
  });

  it("preserves every legacy outbox entry when Web Locks are unavailable", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("no-locks");
    const canonicalName = "hanji-outbox:no-locks";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "uncertain",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [
          {
            legacyName,
            canonicalName,
            consumeStores: ["entries"],
            respectLegacyOutboxLiveness: true,
          },
        ],
        factory,
        { locks: null }
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "uncertain", value: { source: "legacy" } }),
    ]);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await expect(canonicalRaw.listEntries()).resolves.toEqual([]);
    const canonicalBox = await createSecretBox(canonicalName, { factory });
    await expect(
      encryptOutboxAdapter<{ source: string }>(legacyRaw, canonicalBox).listEntries()
    ).resolves.toEqual([
      expect.objectContaining({ entryKey: "uncertain", value: { source: "legacy" } }),
    ]);
  });

  it("does not create a divergent canonical key when the pre-claim lock fails", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("lock-before-claim");
    const canonicalName = "hanji-outbox:lock-before-claim";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacy.put({
      entryKey: "recoverable",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });
    const locks: LegacyNamespaceLockManager = {
      async request() {
        throw new Error("lock service failed");
      },
    };

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory,
        { exclusiveLockName: canonicalName, locks }
      )
    ).rejects.toThrow("Legacy IndexedDB migration was deferred");
    await expect(legacy.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "recoverable", value: { source: "legacy" } }),
    ]);
    await expect(factory.databases()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: `${canonicalName}::keys` })])
    );
  });

  it("loses a mid-migration canonical-key race without copying any legacy ciphertext", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("key-race");
    const canonicalName = "hanji-outbox:key-race";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "legacy-only",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory,
        { beforeKeyClaimForTest: async () => {
          // The canonical-key existence check has its old snapshot, then
          // another tab commits a key before migration's claim transaction.
          await createSecretBox(canonicalName, { factory });
        } }
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "legacy-only", value: { source: "legacy" } }),
    ]);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await expect(canonicalRaw.listEntries()).resolves.toEqual([]);
  });

  it("keeps the legacy source when provenance changes after data copy", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("post-copy-rekey");
    const canonicalName = "hanji-outbox:post-copy-rekey";
    const keyPair = {
      legacyName: `${legacyName}::keys`,
      canonicalName: `${canonicalName}::keys`,
    };
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await expect(migrateLegacyIndexedDbProvenance(keyPair, [], factory)).resolves.toBe(
      "migrated"
    );
    await legacyAdapter.put({
      entryKey: "recoverable",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        keyPair,
        [{ legacyName, canonicalName, consumeStores: ["entries"] }],
        factory,
        {
          beforeProvenanceRecheckForTest: async () => {
            const canonicalKeys = await openDatabase(factory, keyPair.canonicalName);
            const storeNames = Array.from(canonicalKeys.objectStoreNames);
            const transaction = canonicalKeys.transaction(storeNames, "readwrite");
            const done = transactionDone(transaction);
            for (const storeName of storeNames) transaction.objectStore(storeName).clear();
            await done;
            canonicalKeys.close();
            await createSecretBox(canonicalName, { factory });
          },
        }
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "recoverable", value: { source: "legacy" } }),
    ]);
  });

  it("preserves a concurrently created canonical key database with a foreign schema", async () => {
    const factory = new IDBFactory();
    const deleteSpy = vi.spyOn(factory, "deleteDatabase");
    const legacyName = legacyOutboxDatabaseName("key-schema-race");
    const canonicalName = "hanji-outbox:key-schema-race";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "legacy-only",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });
    const canonicalKeyName = `${canonicalName}::keys`;

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: canonicalKeyName,
        },
        [{ legacyName, canonicalName }],
        factory,
        { beforeKeyClaimForTest: async () => {
          const canonicalKey = await openDatabase(factory, canonicalKeyName, (database) => {
            database.createObjectStore("future-keys");
          });
          const transaction = canonicalKey.transaction("future-keys", "readwrite");
          const done = transactionDone(transaction);
          transaction.objectStore("future-keys").put("canonical", "active");
          await done;
          canonicalKey.close();
        } }
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "legacy-only", value: { source: "legacy" } }),
    ]);
    const canonicalKey = await openDatabase(factory, canonicalKeyName);
    expect(Array.from(canonicalKey.objectStoreNames)).toEqual(["future-keys"]);
    canonicalKey.close();
    expect(deleteSpy).not.toHaveBeenCalledWith(canonicalKeyName);
  });

  it("fails closed when a key-claim race leaves an empty unusable target", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("empty-key-race");
    const canonicalName = "hanji-outbox:empty-key-race";
    const canonicalKeyName = `${canonicalName}::keys`;
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    if (!legacyRaw) throw new Error("fake IndexedDB unavailable");
    const legacy = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    await legacy.put({
      entryKey: "recoverable",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: canonicalKeyName,
        },
        [{ legacyName, canonicalName }],
        factory,
        {
          beforeKeyClaimForTest: async () => {
            const unusable = await openDatabase(factory, canonicalKeyName, (database) => {
              database.createObjectStore("future-empty-keys");
            });
            unusable.close();
          },
        }
      )
    ).rejects.toThrow("Legacy IndexedDB migration was deferred");
    await expect(legacy.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "recoverable", value: { source: "legacy" } }),
    ]);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!canonicalRaw) throw new Error("fake IndexedDB unavailable");
    await expect(canonicalRaw.listEntries()).resolves.toEqual([]);
  });

  it("preserves both device-key namespaces when a partial deploy created divergent keys", async () => {
    const factory = new IDBFactory();
    const legacyName = legacyOutboxDatabaseName("divergent-device");
    const canonicalName = "hanji-outbox:divergent-device";
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyName, factory);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalName, factory);
    if (!legacyRaw || !canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      await createSecretBox(legacyName, { factory })
    );
    const canonicalAdapter = encryptOutboxAdapter<{ source: string }>(
      canonicalRaw,
      await createSecretBox(canonicalName, { factory })
    );
    await legacyAdapter.put({
      entryKey: "legacy-only",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });
    await canonicalAdapter.put({
      entryKey: "canonical-only",
      tabId: "new-tab",
      updatedAt: 2,
      value: { source: "canonical" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyName}::keys`,
          canonicalName: `${canonicalName}::keys`,
        },
        [{ legacyName, canonicalName }],
        factory
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "legacy-only", value: { source: "legacy" } }),
    ]);
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({ entryKey: "canonical-only", value: { source: "canonical" } }),
    ]);
  });

  it("preserves both passphrase-key namespaces when rollback keys diverged", async () => {
    const factory = new IDBFactory();
    const userId = "divergent-passphrase";
    const legacyDataName = legacyOutboxDatabaseName(userId);
    const canonicalDataName = `hanji-outbox:${userId}`;
    const legacyLockName = legacyLockBoxName(userId);
    const canonicalLockName = `hanji-lock:${userId}`;
    const legacyBoxResult = await createPassphraseSecretBox(
      legacyLockName,
      "legacy passphrase",
      { ...FAST_PASSPHRASE, factory }
    );
    const canonicalBoxResult = await createPassphraseSecretBox(
      canonicalLockName,
      "canonical passphrase",
      { ...FAST_PASSPHRASE, factory }
    );
    if ("error" in legacyBoxResult || "error" in canonicalBoxResult) {
      throw new Error("passphrase boxes unavailable");
    }
    const legacyRaw = createIndexedDbOutboxAdapter<unknown>(legacyDataName, factory);
    const canonicalRaw = createIndexedDbOutboxAdapter<unknown>(canonicalDataName, factory);
    if (!legacyRaw || !canonicalRaw) throw new Error("fake IndexedDB unavailable");
    const legacyAdapter = encryptOutboxAdapter<{ source: string }>(
      legacyRaw,
      legacyBoxResult.box
    );
    const canonicalAdapter = encryptOutboxAdapter<{ source: string }>(
      canonicalRaw,
      canonicalBoxResult.box
    );
    await legacyAdapter.put({
      entryKey: "legacy-passphrase",
      tabId: "old-tab",
      updatedAt: 1,
      value: { source: "legacy" },
    });
    await canonicalAdapter.put({
      entryKey: "canonical-passphrase",
      tabId: "new-tab",
      updatedAt: 2,
      value: { source: "canonical" },
    });

    await expect(
      migrateLegacyIndexedDbProvenance(
        {
          legacyName: `${legacyLockName}::keys`,
          canonicalName: `${canonicalLockName}::keys`,
        },
        [{ legacyName: legacyDataName, canonicalName: canonicalDataName }],
        factory
      )
    ).resolves.toBe("preserved-conflict");
    await expect(legacyAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({
        entryKey: "legacy-passphrase",
        value: { source: "legacy" },
      }),
    ]);
    await expect(canonicalAdapter.listEntries()).resolves.toEqual([
      expect.objectContaining({
        entryKey: "canonical-passphrase",
        value: { source: "canonical" },
      }),
    ]);
  });
});
