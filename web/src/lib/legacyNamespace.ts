/*
 * Read-only compatibility for browser data created before the Hanji rename.
 *
 * Keep every old product namespace in this file. Callers consume normalized
 * Hanji values and must never write an old key, MIME type, URI, HTML marker,
 * native-export format, or IndexedDB name. The service worker is the sole
 * exception because a classic public worker cannot import this TypeScript
 * module; it keeps one old cache prefix to validate/handoff immutable assets,
 * serve a storage-failure fallback, and then delete only the cache it owns.
 */

const LEGACY_NAMESPACE = "notionlike";
const CANONICAL_NAMESPACE = "hanji";

export const LEGACY_HANJI_URI_PREFIX = "notionlike://";
const CANONICAL_HANJI_URI_PREFIX = "hanji://";

const LEGACY_BLOCKS_MIME = "application/x-notionlike-blocks";
const LEGACY_TABLE_ROWS_MIME = "application/x-notionlike-table-rows";
const CANONICAL_BLOCKS_MIME = "application/x-hanji-blocks";
const CANONICAL_TABLE_ROWS_MIME = "application/x-hanji-table-rows";

const LEGACY_HTML_ATTRIBUTE_PREFIX = "data-notionlike-";
const CANONICAL_HTML_ATTRIBUTE_PREFIX = "data-hanji-";

const LEGACY_NATIVE_FILE_RE = /\.(?:inkline|notionlike)(?:\.json)?$/i;
const LEGACY_NATIVE_FORMATS = new Set(["inkline.export", "notionlike.export"]);
const CANONICAL_NATIVE_FORMAT = "hanji.export";

const indexedDbMigrations = new Map<string, Promise<LegacyIndexedDbMigrationResult>>();

function canonicalBrowserStorageKey(key: string): string | null {
  const match = key.match(/^notionlike(?=[:.\-]|$)/i);
  return match ? `${CANONICAL_NAMESPACE}${key.slice(match[0].length)}` : null;
}

function migrateStorage(storage: Storage | undefined) {
  if (!storage) return;
  let keys: string[];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => !!key
    );
  } catch {
    return;
  }
  for (const oldKey of keys) {
    const nextKey = canonicalBrowserStorageKey(oldKey);
    if (!nextKey || nextKey === oldKey) continue;
    try {
      const oldValue = storage.getItem(oldKey);
      if (oldValue !== null && storage.getItem(nextKey) === null) {
        storage.setItem(nextKey, oldValue);
      }
    } catch {
      // Storage is optional. Retry seeding on the next boot.
    }
  }
}

/** Seed Hanji keys while old tabs keep their read-only rolling-window keys. */
export function migrateLegacyBrowserStorage() {
  if (typeof window === "undefined") return;
  migrateStorage(window.localStorage);
  migrateStorage(window.sessionStorage);
}

function clearLegacyStorage(storage: Storage | undefined) {
  if (!storage) return;
  let keys: string[];
  try {
    keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(
      (key): key is string => !!key
    );
  } catch {
    return;
  }
  for (const key of keys) {
    if (!canonicalBrowserStorageKey(key)) continue;
    try {
      storage.removeItem(key);
    } catch {
      // Best-effort explicit privacy cleanup on storage-restricted browsers.
    }
  }
}

/** Explicit sign-out/reset cleanup; unlike boot migration this may notify old tabs. */
export function clearLegacyBrowserStorage() {
  if (typeof window === "undefined") return;
  clearLegacyStorage(window.localStorage);
  clearLegacyStorage(window.sessionStorage);
}

/** Read a current custom clipboard payload, falling back to its old MIME alias. */
export function readLegacyCompatibleClipboardData(data: DataTransfer, canonicalMime: string) {
  const current = data.getData(canonicalMime);
  if (current) return current;
  const legacyMime =
    canonicalMime === CANONICAL_BLOCKS_MIME
      ? LEGACY_BLOCKS_MIME
      : canonicalMime === CANONICAL_TABLE_ROWS_MIME
        ? LEGACY_TABLE_ROWS_MIME
        : "";
  return legacyMime ? data.getData(legacyMime) : "";
}

/** Normalize old internal links before parsing; serializers emit only hanji://. */
export function normalizeLegacyHanjiUri(value: string) {
  return value.toLowerCase().startsWith(LEGACY_HANJI_URI_PREFIX)
    ? `${CANONICAL_HANJI_URI_PREFIX}${value.slice(LEGACY_HANJI_URI_PREFIX.length)}`
    : value;
}

/** Normalize copied rich HTML before querying Hanji's private data attributes. */
export function normalizeLegacyHanjiClipboardHtml(value: string) {
  return value.replaceAll(LEGACY_HTML_ATTRIBUTE_PREFIX, CANONICAL_HTML_ATTRIBUTE_PREFIX);
}

export function isLegacyHanjiNativeFileName(fileName: string) {
  return LEGACY_NATIVE_FILE_RE.test(fileName);
}

/** Convert an old native envelope in memory; imports persist the canonical format. */
export function normalizeLegacyHanjiNativeDocument(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return typeof record.format === "string" && LEGACY_NATIVE_FORMATS.has(record.format)
    ? { ...record, format: CANONICAL_NATIVE_FORMAT }
    : value;
}

export function legacyOutboxDatabaseName(userId: string) {
  return `notionlike-outbox:${userId}`;
}

export function legacyRecordCacheDatabaseName(userId: string) {
  return `notionlike-records:${userId}`;
}

export function legacyLockBoxName(userId: string) {
  return `notionlike-lock:${userId}`;
}

export function legacyRecordCacheMigrationMarkerKey(userId: string) {
  return `hanji.migration.record-cache:${userId}:v1`;
}

interface StoreSchema {
  autoIncrement: boolean;
  indexes: Array<{
    keyPath: string | string[];
    multiEntry: boolean;
    name: string;
    unique: boolean;
  }>;
  keyPath: string | string[] | null;
  name: string;
}

interface StoreDump {
  keys: IDBValidKey[];
  schema: StoreSchema;
  values: unknown[];
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

async function databaseExists(factory: IDBFactory, name: string): Promise<boolean> {
  const withListing = factory as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof withListing.databases === "function") {
    try {
      return (await withListing.databases()).some((database) => database.name === name);
    } catch {
      // Fall through to the create-and-remove probe for older/private browsers.
    }
  }

  return new Promise((resolve) => {
    let created = false;
    const request = factory.open(name);
    request.onupgradeneeded = (event) => {
      created = event.oldVersion === 0;
    };
    request.onsuccess = () => {
      request.result.close();
      if (created) factory.deleteDatabase(name);
      resolve(!created);
    };
    request.onerror = () => resolve(false);
  });
}

function openDatabase(factory: IDBFactory, name: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = version === undefined ? factory.open(name) : factory.open(name, version);
    request.onsuccess = () => {
      if (settled) {
        // `blocked` is not terminal: the request can still succeed after the
        // old handle closes. Its promise was already rejected fail-open, so a
        // late result must be closed instead of leaking an invisible handle.
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Failed to open IndexedDB '${name}'.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB '${name}' open was blocked.`));
    };
  });
}

function describeStores(database: IDBDatabase): StoreSchema[] {
  const names = Array.from(database.objectStoreNames);
  if (names.length === 0) return [];
  const transaction = database.transaction(names, "readonly");
  return names.map((name) => {
    const store = transaction.objectStore(name);
    return {
      autoIncrement: store.autoIncrement,
      indexes: Array.from(store.indexNames).map((indexName) => {
        const index = store.index(indexName);
        return {
          keyPath: index.keyPath,
          multiEntry: index.multiEntry,
          name: index.name,
          unique: index.unique,
        };
      }),
      keyPath: store.keyPath,
      name,
    };
  });
}

function openMigrationTarget(
  factory: IDBFactory,
  name: string,
  version: number,
  schemas: StoreSchema[]
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = factory.open(name, version);
    request.onupgradeneeded = () => {
      if (settled) {
        // A request rejected on `blocked` may later enter its upgrade after
        // the blocker disappears. Abort that now-unowned schema mutation.
        request.transaction?.abort();
        return;
      }
      const database = request.result;
      for (const schema of schemas) {
        if (database.objectStoreNames.contains(schema.name)) continue;
        const store = database.createObjectStore(schema.name, {
          autoIncrement: schema.autoIncrement,
          keyPath: schema.keyPath,
        });
        for (const index of schema.indexes) {
          store.createIndex(index.name, index.keyPath, {
            multiEntry: index.multiEntry,
            unique: index.unique,
          });
        }
      }
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error(`Failed to create IndexedDB '${name}'.`));
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new Error(`IndexedDB '${name}' migration was blocked.`));
    };
  });
}

async function readStore(database: IDBDatabase, name: string) {
  const transaction = database.transaction(name, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(name);
  const [keys, values] = await Promise.all([
    requestResult(store.getAllKeys()),
    requestResult(store.getAll()),
  ]);
  await done;
  return { keys, values };
}

const MIGRATION_BATCH_SIZE = 128;

async function readStoreChunk(
  factory: IDBFactory,
  database: IDBDatabase,
  name: string,
  afterKey?: IDBValidKey
) {
  const transaction = database.transaction(name, "readonly");
  const done = transactionDone(transaction);
  const result = await new Promise<{ keys: IDBValidKey[]; values: unknown[] }>(
    (resolve, reject) => {
      const keys: IDBValidKey[] = [];
      const values: unknown[] = [];
      const request = transaction.objectStore(name).openCursor();
      request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed."));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve({ keys, values });
          return;
        }
        if (afterKey !== undefined) {
          const comparison = factory.cmp(cursor.primaryKey, afterKey);
          if (comparison < 0) {
            cursor.continue(afterKey);
            return;
          }
          if (comparison === 0) {
            cursor.continue();
            return;
          }
        }
        keys.push(cursor.primaryKey);
        values.push(cursor.value);
        if (keys.length >= MIGRATION_BATCH_SIZE) {
          resolve({ keys, values });
          return;
        }
        cursor.continue();
      };
    }
  );
  await done;
  return result;
}

async function storeValueCount(database: IDBDatabase, name: string) {
  const transaction = database.transaction(name, "readonly");
  const done = transactionDone(transaction);
  const count = await requestResult(transaction.objectStore(name).count());
  await done;
  return count;
}

interface OutboxSequencePrefix {
  invalidSequence: boolean;
  keys: IDBValidKey[];
  values: unknown[];
}

function storedOutboxSequence(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const sequence = (value as { seq?: unknown }).seq;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0
    ? sequence
    : null;
}

/**
 * Find the global replay prefix without loading the whole outbox. The backing
 * store is keyed by tab/key rather than seq, so scan once while retaining only
 * the lowest MIGRATION_BATCH_SIZE candidates in memory.
 */
async function readOutboxSequencePrefix(
  factory: IDBFactory,
  database: IDBDatabase
): Promise<OutboxSequencePrefix> {
  const transaction = database.transaction("entries", "readonly");
  const done = transactionDone(transaction);
  const result = await new Promise<OutboxSequencePrefix>((resolve, reject) => {
    const candidates: Array<{ key: IDBValidKey; sequence: number; value: unknown }> = [];
    const request = transaction.objectStore("entries").openCursor();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({
          invalidSequence: false,
          keys: candidates.map((candidate) => candidate.key),
          values: candidates.map((candidate) => candidate.value),
        });
        return;
      }
      const sequence = storedOutboxSequence(cursor.value);
      if (sequence === null) {
        resolve({ invalidSequence: true, keys: [], values: [] });
        return;
      }
      const candidate = { key: cursor.primaryKey, sequence, value: cursor.value };
      let lower = 0;
      let upper = candidates.length;
      while (lower < upper) {
        const middle = Math.floor((lower + upper) / 2);
        const compared = candidates[middle];
        const order =
          compared.sequence === sequence
            ? factory.cmp(compared.key, candidate.key)
            : compared.sequence - sequence;
        if (order <= 0) lower = middle + 1;
        else upper = middle;
      }
      candidates.splice(lower, 0, candidate);
      if (candidates.length > MIGRATION_BATCH_SIZE) candidates.pop();
      cursor.continue();
    };
  });
  await done;
  return result;
}

async function mergeStore(
  database: IDBDatabase,
  name: string,
  keys: IDBValidKey[],
  values: unknown[]
) {
  if (keys.length === 0) return 0;
  const transaction = database.transaction(name, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(name);
  keys.forEach((key, index) => {
    const existing = store.get(key);
    existing.onsuccess = () => {
      const value = values[index];
      if (name === "meta" && key === "seq" && typeof value === "number") {
        const current = existing.result;
        if (current === undefined) store.put(value, key);
        else if (typeof current === "number") store.put(Math.max(current, value), key);
      } else if (existing.result === undefined) {
        if (store.keyPath === null) store.put(value, key);
        else store.put(value);
      } else if (
        name === "entries" &&
        typeof value === "object" &&
        value !== null &&
        typeof (value as { updatedAt?: unknown }).updatedAt === "number" &&
        typeof existing.result === "object" &&
        existing.result !== null &&
        typeof (existing.result as { updatedAt?: unknown }).updatedAt === "number" &&
        (value as { updatedAt: number }).updatedAt >
          (existing.result as { updatedAt: number }).updatedAt
      ) {
        // Durable-outbox composite keys can be rewritten by a still-open old
        // tab after the first migration. Preserve the newer outer timestamp;
        // the encrypted value itself remains opaque but shares key provenance.
        store.put(value);
      }
    };
  });
  await done;
}

function sameKeyPath(left: string | string[] | null, right: string | string[] | null) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetSupportsSchemas(database: IDBDatabase, schemas: StoreSchema[]) {
  const names = Array.from(database.objectStoreNames);
  if (schemas.some((schema) => !names.includes(schema.name))) return false;
  if (schemas.length === 0) return true;
  const transaction = database.transaction(
    schemas.map((schema) => schema.name),
    "readonly"
  );
  return schemas.every((schema) => {
    const store = transaction.objectStore(schema.name);
    if (store.autoIncrement !== schema.autoIncrement || !sameKeyPath(store.keyPath, schema.keyPath)) {
      return false;
    }
    return schema.indexes.every((expected) => {
      if (!store.indexNames.contains(expected.name)) return false;
      const actual = store.index(expected.name);
      return (
        actual.multiEntry === expected.multiEntry &&
        actual.unique === expected.unique &&
        sameKeyPath(actual.keyPath, expected.keyPath)
      );
    });
  });
}

async function migrationTarget(
  factory: IDBFactory,
  name: string,
  version: number,
  sourceSchemas: StoreSchema[]
) {
  // One open request both creates a missing target and observes a concurrently
  // created one, avoiding an existence-check TOCTOU window.
  let current: IDBDatabase;
  try {
    current = await openMigrationTarget(factory, name, version, sourceSchemas);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { name?: unknown }).name !== "VersionError") {
      throw error;
    }
    // A future Hanji release may already own a higher-version canonical DB
    // while this retained v1 legacy witness still exists. Open the current
    // version without downgrading; compatible stores can still be merged and
    // incompatible schemas are preserved below instead of disabling storage.
    current = await openDatabase(factory, name);
  }
  if (targetSupportsSchemas(current, sourceSchemas)) return current;

  // Never delete a partially shaped canonical database. Rebuilding it requires
  // a delete-first window (the adapters intentionally open schema v1), and a
  // crash in that window would lose canonical outbox records. Keep both DBs so
  // a future schema-aware recovery can decide safely.
  current.close();
  return null;
}

export interface LegacyIndexedDbNamePair {
  canonicalName: string;
  legacyName: string;
}

export interface LegacyIndexedDbEarlyMetaKey {
  /** Out-of-line key in the pair's `meta` object store. */
  key: IDBValidKey;
  /** Safety merge performed before payload records are copied. */
  strategy: "max-number" | "require-stored-equality";
}

export const LEGACY_OUTBOX_EARLY_META_KEYS = [
  { key: "seq", strategy: "max-number" },
] as const satisfies readonly LegacyIndexedDbEarlyMetaKey[];

export const LEGACY_RECORD_CACHE_EARLY_META_KEYS = [
  { key: "__recordCacheSchemaVersion", strategy: "require-stored-equality" },
] as const satisfies readonly LegacyIndexedDbEarlyMetaKey[];

export interface LegacyIndexedDbDataPair extends LegacyIndexedDbNamePair {
  /** Explicit privacy-clear tombstone; outbox pairs must never set this. */
  suppressionMarkerKey?: string;
  /** Safety metadata copied before payload, then rechecked after the last batch. */
  earlyMetaKeys?: readonly LegacyIndexedDbEarlyMetaKey[];
  /** Source stores whose copied records are CAS-consumed (outbox entries). */
  consumeStores?: readonly string[];
  /** Protect old-tab entries with the legacy DurableOutbox liveness locks. */
  respectLegacyOutboxLiveness?: boolean;
  /** Canonical records may supersede source values (disposable cache move). */
  consumeCanonicalConflicts?: boolean;
  /** Skip this pair entirely when the cross-tab lock authority is unavailable. */
  requireExclusiveLock?: boolean;
}

export interface LegacyNamespaceLockManager {
  request<T>(
    name: string,
    options: { ifAvailable?: boolean; mode?: "exclusive" | "shared" },
    callback: (lock: unknown | null) => T | Promise<T>
  ): Promise<T>;
}

export interface LegacyIndexedDbMigrationOptions {
  /** Canonical outbox re-key lock shared with current Hanji mutations. */
  exclusiveLockName?: string;
  /** The caller already owns exclusiveLockName (outboxRekey re-entry). */
  exclusiveLockAlreadyHeld?: boolean;
  /** Deterministic test seam for the inspect -> atomic key-claim race. */
  beforeKeyClaimForTest?: () => Promise<void>;
  /** Test seam for an uncooperative key change after data copy. */
  beforeProvenanceRecheckForTest?: () => Promise<void>;
  /** Test seam for deterministic data-batch storage failures. */
  beforeDataBatchMergeForTest?: (
    storeName: string,
    batchIndex: number,
    batchSize: number
  ) => Promise<void>;
  /** Test override; undefined resolves navigator.locks, null is unavailable. */
  locks?: LegacyNamespaceLockManager | null;
}

export type LegacyIndexedDbMigrationResult =
  | "migrated"
  | "not-needed"
  | "preserved-conflict";

class LegacyIndexedDbMigrationError extends Error {
  readonly canonicalKeyReady: boolean;

  constructor(cause: unknown, canonicalKeyReady: boolean) {
    super("Legacy IndexedDB migration was deferred.", { cause });
    this.name = "LegacyIndexedDbMigrationError";
    this.canonicalKeyReady = canonicalKeyReady;
  }
}

/** Data-copy failures are recoverable only after canonical key provenance is established. */
export function legacyIndexedDbMigrationCanContinue(error: unknown) {
  return error instanceof LegacyIndexedDbMigrationError && error.canonicalKeyReady;
}

const SUPPRESSED_MIGRATION_MARKER = "suppressed";

function readCompletedMarker(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function migrationPairSuppressed(pair: LegacyIndexedDbDataPair) {
  if (!pair.suppressionMarkerKey) return false;
  return readCompletedMarker(pair.suppressionMarkerKey) === SUPPRESSED_MIGRATION_MARKER;
}

function suppressMigrationMarker(key: string) {
  try {
    globalThis.localStorage?.setItem(key, SUPPRESSED_MIGRATION_MARKER);
  } catch {
    // Best-effort. The legacy database was still cleared below.
  }
}

interface DatabaseState {
  exists: boolean;
  hasSealedValue: boolean;
  hasValues: boolean;
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function storedValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  const leftBytes = bytesOf(left);
  const rightBytes = bytesOf(right);
  if (leftBytes || rightBytes) {
    if (!leftBytes || !rightBytes || leftBytes.byteLength !== rightBytes.byteLength) return false;
    return leftBytes.every((byte, index) => byte === rightBytes[index]);
  }
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => storedValuesEqual(value, right[index]))
    );
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && storedValuesEqual(leftRecord[key], rightRecord[key])
    )
  );
}

function asCryptoKey(value: unknown): CryptoKey | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CryptoKey>;
  return (
    typeof candidate.type === "string" &&
    typeof candidate.extractable === "boolean" &&
    !!candidate.algorithm &&
    Array.isArray(candidate.usages)
  )
    ? (value as CryptoKey)
    : null;
}

async function cryptoKeysEquivalent(left: CryptoKey, right: CryptoKey): Promise<boolean> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== "function") return false;
  if (left.algorithm.name !== "AES-GCM" || right.algorithm.name !== "AES-GCM") return false;
  if (!left.usages.includes("encrypt") || !right.usages.includes("decrypt")) return false;
  try {
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const payload = cryptoApi.getRandomValues(new Uint8Array(32));
    const sealed = await cryptoApi.subtle.encrypt({ iv, name: "AES-GCM" }, left, payload);
    const opened = new Uint8Array(
      await cryptoApi.subtle.decrypt({ iv, name: "AES-GCM" }, right, sealed)
    );
    return storedValuesEqual(payload, opened);
  } catch {
    return false;
  }
}

async function keyValuesEquivalent(left: unknown, right: unknown) {
  const leftKey = asCryptoKey(left);
  const rightKey = asCryptoKey(right);
  if (leftKey || rightKey) {
    return !!leftKey && !!rightKey && cryptoKeysEquivalent(leftKey, rightKey);
  }
  return storedValuesEqual(left, right);
}

function containsSealedValue(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  if (
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return false;
  }
  const object = value as Record<string, unknown>;
  if (object.__sealed === 1) return true;
  if (seen.has(object)) return false;
  seen.add(object);
  return Object.values(object).some((child) => containsSealedValue(child, seen, depth + 1));
}

async function storeHasSealedValue(database: IDBDatabase, storeName: string): Promise<boolean> {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const found = await new Promise<boolean>((resolve, reject) => {
    const request = transaction.objectStore(storeName).openCursor();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed."));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(false);
        return;
      }
      if (containsSealedValue(cursor.value)) {
        resolve(true);
        return;
      }
      cursor.continue();
    };
  });
  await done;
  return found;
}

async function inspectDatabase(
  factory: IDBFactory,
  name: string,
  scanForSealedValue = true
): Promise<DatabaseState> {
  if (!(await databaseExists(factory, name))) {
    return { exists: false, hasSealedValue: false, hasValues: false };
  }
  const database = await openDatabase(factory, name);
  try {
    let hasValues = false;
    let hasSealedValue = false;
    for (const storeName of Array.from(database.objectStoreNames)) {
      const transaction = database.transaction(storeName, "readonly");
      const done = transactionDone(transaction);
      const count = await requestResult(transaction.objectStore(storeName).count());
      await done;
      if (count > 0) hasValues = true;
      if (scanForSealedValue && count > 0 && (await storeHasSealedValue(database, storeName))) {
        hasSealedValue = true;
      }
    }
    return { exists: true, hasSealedValue, hasValues };
  } finally {
    database.close();
  }
}

async function clearExistingDatabase(factory: IDBFactory, name: string): Promise<boolean> {
  if (!(await databaseExists(factory, name))) return false;
  const database = await openDatabase(factory, name);
  try {
    const storeNames = Array.from(database.objectStoreNames);
    if (storeNames.length === 0) return true;
    const transaction = database.transaction(storeNames, "readwrite");
    const done = transactionDone(transaction);
    for (const storeName of storeNames) transaction.objectStore(storeName).clear();
    await done;
    return true;
  } finally {
    database.close();
  }
}

/** Explicit outbox privacy cleanup; rolling migration itself never clears whole DBs. */
export async function clearLegacyOutboxStorage(
  userId: string,
  factory: IDBFactory | undefined = globalThis.indexedDB
) {
  if (!userId || !factory) return false;
  const name = legacyOutboxDatabaseName(userId);
  return withExclusiveNamespaceLocks(
    resolveNamespaceLocks(undefined),
    [name, `${name}::sweep`],
    async () => {
      const results = await Promise.all([
        clearExistingDatabase(factory, name),
        clearExistingDatabase(factory, `${name}::keys`),
      ]);
      return results.some(Boolean);
    }
  );
}

/** Clear old cached content and its per-store device key on invalidation/delete. */
export async function clearLegacyRecordCacheStorage(
  userId: string,
  factory: IDBFactory | undefined = globalThis.indexedDB
) {
  if (!userId || !factory) return false;
  const name = legacyRecordCacheDatabaseName(userId);
  const results = await Promise.all([
    clearExistingDatabase(factory, name),
    clearExistingDatabase(factory, `${name}::keys`),
  ]);
  suppressMigrationMarker(legacyRecordCacheMigrationMarkerKey(userId));
  return results.some(Boolean);
}

/** Clear the old shared passphrase wrapper after sign-out cleared both data DBs. */
export async function clearLegacyPassphraseKeyStorage(
  userId: string,
  factory: IDBFactory | undefined = globalThis.indexedDB
) {
  if (!userId || !factory) return false;
  return withExclusiveNamespaceLocks(
    resolveNamespaceLocks(undefined),
    [legacyOutboxDatabaseName(userId)],
    () => clearExistingDatabase(factory, `${legacyLockBoxName(userId)}::keys`)
  );
}

/**
 * Final sign-out sweep uses migration's canonical bare/sweep -> legacy
 * bare/sweep order. Re-clear canonical data too: neither generation's
 * claimAbandoned() nor migration can recreate records after logout.
 */
export async function clearLegacyLocalDataOnSignOut(
  userId: string,
  factory: IDBFactory | undefined = globalThis.indexedDB
) {
  if (!userId || !factory) return false;
  const canonicalOutbox = `hanji-outbox:${userId}`;
  const canonicalRecords = `hanji-records:${userId}`;
  const legacyOutbox = legacyOutboxDatabaseName(userId);
  const legacyRecords = legacyRecordCacheDatabaseName(userId);
  return withExclusiveNamespaceLocks(
    resolveNamespaceLocks(undefined),
    [
      canonicalOutbox,
      `${canonicalOutbox}::sweep`,
      legacyOutbox,
      `${legacyOutbox}::sweep`,
    ],
    async () => {
      const keyResults = await Promise.all([
        clearExistingDatabase(factory, `${legacyOutbox}::keys`),
        clearExistingDatabase(factory, `${legacyRecords}::keys`),
        clearExistingDatabase(factory, `${legacyLockBoxName(userId)}::keys`),
      ]);
      const dataResults = await Promise.all([
        clearExistingDatabase(factory, canonicalOutbox),
        clearExistingDatabase(factory, canonicalRecords),
        clearExistingDatabase(factory, legacyOutbox),
        clearExistingDatabase(factory, legacyRecords),
      ]);
      suppressMigrationMarker(legacyRecordCacheMigrationMarkerKey(userId));
      return [...keyResults, ...dataResults].some(Boolean);
    }
  );
}

async function readDatabaseDumps(factory: IDBFactory, name: string) {
  const database = await openDatabase(factory, name);
  try {
    const dumps: StoreDump[] = [];
    for (const schema of describeStores(database)) {
      dumps.push({ schema, ...(await readStore(database, schema.name)) });
    }
    return dumps;
  } finally {
    database.close();
  }
}

async function keyDatabasesEquivalent(
  factory: IDBFactory,
  legacyName: string,
  canonicalName: string
) {
  const [legacyDumps, canonicalDumps] = await Promise.all([
    readDatabaseDumps(factory, legacyName),
    readDatabaseDumps(factory, canonicalName),
  ]);
  if (legacyDumps.length !== canonicalDumps.length) return false;
  for (let storeIndex = 0; storeIndex < legacyDumps.length; storeIndex += 1) {
    const legacy = legacyDumps[storeIndex];
    const canonical = canonicalDumps[storeIndex];
    if (
      legacy.schema.name !== canonical.schema.name ||
      legacy.keys.length !== canonical.keys.length ||
      legacy.values.length !== canonical.values.length
    ) {
      return false;
    }
    for (let index = 0; index < legacy.keys.length; index += 1) {
      if (!storedValuesEqual(legacy.keys[index], canonical.keys[index])) return false;
      if (!(await keyValuesEquivalent(legacy.values[index], canonical.values[index]))) return false;
    }
  }
  return true;
}

function resolveNamespaceLocks(
  override: LegacyNamespaceLockManager | null | undefined
): LegacyNamespaceLockManager | null {
  if (override !== undefined) return override;
  try {
    const candidate = (globalThis as { navigator?: { locks?: unknown } }).navigator?.locks;
    return candidate &&
      typeof (candidate as LegacyNamespaceLockManager).request === "function"
      ? (candidate as LegacyNamespaceLockManager)
      : null;
  } catch {
    return null;
  }
}

function entryTabId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const tabId = (value as { tabId?: unknown }).tabId;
  return typeof tabId === "string" && tabId ? tabId : null;
}

async function legacyOutboxTabIds(factory: IDBFactory, name: string): Promise<string[]> {
  const database = await openDatabase(factory, name);
  try {
    if (!database.objectStoreNames.contains("entries")) return [];
    const tabIds = new Set<string>();
    let afterKey: IDBValidKey | undefined;
    while (true) {
      const chunk = await readStoreChunk(factory, database, "entries", afterKey);
      for (const value of chunk.values) {
        const tabId = entryTabId(value);
        if (tabId) tabIds.add(tabId);
      }
      if (chunk.keys.length < MIGRATION_BATCH_SIZE) break;
      afterKey = chunk.keys.at(-1);
    }
    return [...tabIds];
  } finally {
    database.close();
  }
}

async function withLegacyOutboxTabLocks<T>(
  factory: IDBFactory,
  databaseName: string,
  locks: LegacyNamespaceLockManager | null,
  operation: (migratableTabIds: ReadonlySet<string>) => Promise<T>
): Promise<{ skippedLiveOrUnknown: boolean; value: T }> {
  const tabIds = await legacyOutboxTabIds(factory, databaseName);
  const migratable = new Set<string>();
  let skippedLiveOrUnknown = false;
  if (!locks) {
    // Without a liveness authority, treating old tabs as dead can replay an op
    // that a still-open old bundle is already flushing. Preserve every entry.
    return {
      skippedLiveOrUnknown: tabIds.length > 0,
      value: await operation(migratable),
    };
  }

  const visit = async (index: number): Promise<T> => {
    if (index >= tabIds.length) return operation(migratable);
    const tabId = tabIds[index];
    let callbackStarted = false;
    try {
      return await locks.request(
        `${databaseName}::tab::${tabId}`,
        { ifAvailable: true, mode: "exclusive" },
        async (lock) => {
          callbackStarted = true;
          if (lock === null) {
            skippedLiveOrUnknown = true;
            return visit(index + 1);
          }
          migratable.add(tabId);
          try {
            // Nested callbacks keep every acquired dead-tab lock held across
            // snapshot, canonical merge, key revalidation and source consume.
            return await visit(index + 1);
          } finally {
            migratable.delete(tabId);
          }
        }
      );
    } catch (error) {
      // A callback error is the migration's error, not evidence that this tab
      // is merely unavailable. Only lock-acquisition failures skip the tab.
      if (callbackStarted) throw error;
      skippedLiveOrUnknown = true;
      return visit(index + 1);
    }
  };

  const value = await visit(0);
  return { skippedLiveOrUnknown, value };
}

interface DatabaseCopyResult {
  provenanceConflict: boolean;
  skippedProtectedEntries: boolean;
}

interface DatabaseCopyOptions {
  beforeBatchMergeForTest?: (
    storeName: string,
    batchIndex: number,
    batchSize: number
  ) => Promise<void>;
  beforePostMergeValidation?: () => Promise<void>;
  consumeCanonicalConflicts: boolean;
  consumeStores: readonly string[];
  earlyMetaKeys: readonly LegacyIndexedDbEarlyMetaKey[];
  protectedOutboxTabIds?: ReadonlySet<string>;
  validateProvenance: () => Promise<boolean>;
}

function indexedDbKeysEqual(factory: IDBFactory, left: IDBValidKey, right: IDBValidKey) {
  try {
    return factory.cmp(left, right) === 0;
  } catch {
    return false;
  }
}

function isEarlyMetaKey(
  factory: IDBFactory,
  key: IDBValidKey,
  earlyMetaKeys: readonly LegacyIndexedDbEarlyMetaKey[]
) {
  return earlyMetaKeys.some((entry) => indexedDbKeysEqual(factory, key, entry.key));
}

async function readStoreValues(
  database: IDBDatabase,
  storeName: string,
  keys: readonly IDBValidKey[]
) {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const values = await Promise.all(keys.map((key) => requestResult(store.get(key))));
  await done;
  return values;
}

function validEarlyMetaSourceValue(spec: LegacyIndexedDbEarlyMetaKey, value: unknown) {
  return spec.strategy === "max-number"
    ? typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    : value !== undefined;
}

function targetOwnsEarlyMetaValue(
  spec: LegacyIndexedDbEarlyMetaKey,
  sourceValue: unknown,
  targetValue: unknown
) {
  if (spec.strategy === "max-number") {
    return (
      typeof sourceValue === "number" &&
      typeof targetValue === "number" &&
      Number.isSafeInteger(targetValue) &&
      targetValue >= sourceValue
    );
  }
  return storedValuesEqual(targetValue, sourceValue);
}

/**
 * Establish safety metadata before payload movement and leave the source as a
 * rolling-upgrade witness. Outbox `seq` uses max-merge; an encrypted record
 * schema marker must be byte-for-byte identical once copied.
 */
async function mergeEarlyMeta(
  source: IDBDatabase,
  target: IDBDatabase,
  specs: readonly LegacyIndexedDbEarlyMetaKey[]
) {
  if (specs.length === 0) return true;
  if (!source.objectStoreNames.contains("meta") || !target.objectStoreNames.contains("meta")) {
    return false;
  }
  const keys = specs.map((spec) => spec.key);
  const sourceValues = await readStoreValues(source, "meta", keys);
  if (!sourceValues.every((value, index) => validEarlyMetaSourceValue(specs[index], value))) {
    return false;
  }
  await mergeStore(target, "meta", [...keys], sourceValues);
  const targetValues = await readStoreValues(target, "meta", keys);
  return targetValues.every((value, index) =>
    targetOwnsEarlyMetaValue(specs[index], sourceValues[index], value)
  );
}

async function consumeSourceBatch(
  source: IDBDatabase,
  target: IDBDatabase,
  storeName: string,
  keys: IDBValidKey[],
  values: unknown[],
  consumeCanonicalConflicts: boolean
): Promise<number> {
  if (keys.length === 0) return 0;
  const targetTransaction = target.transaction(storeName, "readonly");
  const targetDone = transactionDone(targetTransaction);
  const targetStore = targetTransaction.objectStore(storeName);
  const targetValues = await Promise.all(
    keys.map((key) => requestResult(targetStore.get(key)))
  );
  await targetDone;

  const sourceTransaction = source.transaction(storeName, "readwrite");
  const sourceDone = transactionDone(sourceTransaction);
  const sourceStore = sourceTransaction.objectStore(storeName);
  let consumed = 0;
  keys.forEach((key, index) => {
    const current = sourceStore.get(key);
    current.onsuccess = () => {
      const sourceValue = values[index];
      const targetValue = targetValues[index];
      const targetIsNewerOutboxEntry =
        storeName === "entries" &&
        typeof sourceValue === "object" &&
        sourceValue !== null &&
        typeof (sourceValue as { updatedAt?: unknown }).updatedAt === "number" &&
        typeof targetValue === "object" &&
        targetValue !== null &&
        typeof (targetValue as { updatedAt?: unknown }).updatedAt === "number" &&
        (targetValue as { updatedAt: number }).updatedAt >
          (sourceValue as { updatedAt: number }).updatedAt;
      const targetSafelyOwnsValue =
        storedValuesEqual(targetValue, sourceValue) ||
        targetIsNewerOutboxEntry ||
        (consumeCanonicalConflicts && targetValue !== undefined);
      if (storedValuesEqual(current.result, sourceValue) && targetSafelyOwnsValue) {
        sourceStore.delete(key);
        consumed += 1;
      }
    };
  });
  await sourceDone;
  return consumed;
}

function isQuotaExceededError(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { name?: unknown }).name === "QuotaExceededError"
  );
}

async function mergeAndConsumeAdaptive(
  source: IDBDatabase,
  target: IDBDatabase,
  storeName: string,
  keys: IDBValidKey[],
  values: unknown[],
  batchIndex: number,
  options: DatabaseCopyOptions
): Promise<{ consumed: number; provenanceValid: boolean }> {
  if (keys.length === 0) return { consumed: 0, provenanceValid: true };
  try {
    await options.beforeBatchMergeForTest?.(storeName, batchIndex, keys.length);
    await mergeStore(target, storeName, keys, values);
  } catch (error) {
    if (!isQuotaExceededError(error) || keys.length === 1) throw error;
    const midpoint = Math.ceil(keys.length / 2);
    const leftMerged = await mergeAndConsumeAdaptive(
      source,
      target,
      storeName,
      keys.slice(0, midpoint),
      values.slice(0, midpoint),
      batchIndex,
      options
    );
    if (!leftMerged.provenanceValid) return leftMerged;
    const rightMerged = await mergeAndConsumeAdaptive(
      source,
      target,
      storeName,
      keys.slice(midpoint),
      values.slice(midpoint),
      batchIndex,
      options
    );
    return {
      consumed: leftMerged.consumed + rightMerged.consumed,
      provenanceValid: rightMerged.provenanceValid,
    };
  }
  await options.beforePostMergeValidation?.();
  if (!(await options.validateProvenance())) {
    return { consumed: 0, provenanceValid: false };
  }
  let consumed = 0;
  if (options.consumeStores.includes(storeName)) {
    consumed = await consumeSourceBatch(
      source,
      target,
      storeName,
      keys,
      values,
      options.consumeCanonicalConflicts
    );
  }
  return { consumed, provenanceValid: true };
}

async function copyOutboxEntriesBySequence(
  factory: IDBFactory,
  source: IDBDatabase,
  target: IDBDatabase,
  migratableTabIds: ReadonlySet<string>,
  options: DatabaseCopyOptions
): Promise<DatabaseCopyResult> {
  let batchIndex = 0;
  let skippedProtectedEntries = false;
  while (true) {
    const snapshot = await readOutboxSequencePrefix(factory, source);
    if (snapshot.invalidSequence) {
      return { provenanceConflict: true, skippedProtectedEntries };
    }
    if (snapshot.keys.length === 0) {
      return { provenanceConflict: false, skippedProtectedEntries };
    }
    const selected = { keys: [] as IDBValidKey[], values: [] as unknown[] };
    let blockedByLiveOrUnknownTab = false;
    for (let index = 0; index < snapshot.keys.length; index += 1) {
      const tabId = entryTabId(snapshot.values[index]);
      if (!tabId || !migratableTabIds.has(tabId)) {
        skippedProtectedEntries = true;
        blockedByLiveOrUnknownTab = true;
        break;
      }
      selected.keys.push(snapshot.keys[index]);
      selected.values.push(snapshot.values[index]);
    }
    if (selected.keys.length > 0) {
      const merged = await mergeAndConsumeAdaptive(
        source,
        target,
        "entries",
        selected.keys,
        selected.values,
        batchIndex,
        options
      );
      if (!merged.provenanceValid || merged.consumed !== selected.keys.length) {
        return { provenanceConflict: true, skippedProtectedEntries };
      }
    }
    if (blockedByLiveOrUnknownTab || snapshot.keys.length < MIGRATION_BATCH_SIZE) {
      return { provenanceConflict: false, skippedProtectedEntries };
    }
    batchIndex += 1;
  }
}

async function copyDatabase(
  factory: IDBFactory,
  sourceName: string,
  targetName: string,
  options: DatabaseCopyOptions
): Promise<DatabaseCopyResult | null> {
  const source = await openDatabase(factory, sourceName);
  let target: IDBDatabase | null = null;
  try {
    // Metadata is the cache/outbox completeness signal. Promote it only after
    // every payload store finished, so a quota/error cannot advertise a
    // partially moved record set as complete.
    const schemas = describeStores(source).sort((left, right) => {
      if (left.name === "meta") return 1;
      if (right.name === "meta") return -1;
      return left.name.localeCompare(right.name);
    });
    let skippedProtectedEntries = false;
    target = await migrationTarget(factory, targetName, source.version, schemas);
    if (!target) return null;
    if (!(await mergeEarlyMeta(source, target, options.earlyMetaKeys))) {
      return { provenanceConflict: true, skippedProtectedEntries };
    }
    if (!(await options.validateProvenance())) {
      return { provenanceConflict: true, skippedProtectedEntries };
    }
    for (const schema of schemas) {
      if (!target.objectStoreNames.contains(schema.name)) continue;
      if ((await storeValueCount(source, schema.name)) === 0) continue;
      if (schema.name === "entries" && options.protectedOutboxTabIds) {
        const copied = await copyOutboxEntriesBySequence(
          factory,
          source,
          target,
          options.protectedOutboxTabIds,
          options
        );
        if (copied.provenanceConflict) return copied;
        if (copied.skippedProtectedEntries) skippedProtectedEntries = true;
        continue;
      }
      let afterKey: IDBValidKey | undefined;
      let batchIndex = 0;
      while (true) {
        const snapshot = await readStoreChunk(factory, source, schema.name, afterKey);
        const selected = snapshot.keys.reduce<{ keys: IDBValidKey[]; values: unknown[] }>(
          (result, key, index) => {
            if (
              schema.name === "meta" &&
              isEarlyMetaKey(factory, key, options.earlyMetaKeys)
            ) {
              return result;
            }
            result.keys.push(key);
            result.values.push(snapshot.values[index]);
            return result;
          },
          { keys: [], values: [] }
        );
        if (selected.keys.length > 0) {
          const merged = await mergeAndConsumeAdaptive(
            source,
            target,
            schema.name,
            selected.keys,
            selected.values,
            batchIndex,
            options
          );
          if (!merged.provenanceValid) {
            return { provenanceConflict: true, skippedProtectedEntries };
          }
        }
        batchIndex += 1;
        if (snapshot.keys.length < MIGRATION_BATCH_SIZE) break;
        afterKey = snapshot.keys.at(-1);
      }
    }
    // Re-read after the payload batches so a still-open old bundle that raised
    // its outbox sequence during migration cannot be overtaken by a new Hanji
    // enqueue. Source safety metadata remains for later old-tab writes/retries.
    if (!(await mergeEarlyMeta(source, target, options.earlyMetaKeys))) {
      return { provenanceConflict: true, skippedProtectedEntries };
    }
    if (!(await options.validateProvenance())) {
      return { provenanceConflict: true, skippedProtectedEntries };
    }
    return { provenanceConflict: false, skippedProtectedEntries };
  } finally {
    source.close();
    target?.close();
  }
}

async function copyEarlyMetaOnly(
  factory: IDBFactory,
  sourceName: string,
  targetName: string,
  earlyMetaKeys: readonly LegacyIndexedDbEarlyMetaKey[],
  validateProvenance: () => Promise<boolean>
) {
  if (earlyMetaKeys.length === 0) return true;
  const source = await openDatabase(factory, sourceName);
  let target: IDBDatabase | null = null;
  try {
    const schemas = describeStores(source);
    target = await migrationTarget(factory, targetName, source.version, schemas);
    if (!target) return false;
    if (!(await mergeEarlyMeta(source, target, earlyMetaKeys))) return false;
    return validateProvenance();
  } finally {
    source.close();
    target?.close();
  }
}

async function copyKeyDatabaseIfTargetEmpty(
  factory: IDBFactory,
  sourceName: string,
  targetName: string
) {
  const source = await openDatabase(factory, sourceName);
  let target: IDBDatabase | null = null;
  try {
    const schemas = describeStores(source);
    const dumps: StoreDump[] = [];
    for (const schema of schemas) {
      dumps.push({ schema, ...(await readStore(source, schema.name)) });
    }
    const storeNames = schemas.map((schema) => schema.name);
    if (storeNames.length === 0) return false;
    target = await openMigrationTarget(factory, targetName, source.version, schemas);
    const targetStoreNames = Array.from(target.objectStoreNames);
    if (
      !storedValuesEqual(targetStoreNames, storeNames) ||
      !targetSupportsSchemas(target, schemas)
    ) {
      // A target created after inspection with a different/newer key schema is
      // canonical state, not an interrupted data migration. Never rebuild or
      // delete it just to make the legacy key fit.
      return false;
    }
    const transaction = target.transaction(storeNames, "readwrite");
    const done = transactionDone(transaction);
    for (const dump of dumps) {
      const store = transaction.objectStore(dump.schema.name);
      if ((await requestResult(store.getAllKeys())).length > 0) {
        transaction.abort();
        await done.catch(() => {});
        return false;
      }
      dump.keys.forEach((key, index) => {
        if (store.keyPath === null) store.add(dump.values[index], key);
        else store.add(dump.values[index]);
      });
    }
    await done;
    return true;
  } finally {
    source.close();
    target?.close();
  }
}

async function keyProvenanceStillValid(
  factory: IDBFactory,
  keyPair: LegacyIndexedDbNamePair,
  legacyInitiallyHadKey: boolean
) {
  const [legacy, canonical] = await Promise.all([
    inspectDatabase(factory, keyPair.legacyName),
    inspectDatabase(factory, keyPair.canonicalName),
  ]);
  if (!legacyInitiallyHadKey) return !legacy.hasValues;
  return (
    legacy.hasValues &&
    canonical.hasValues &&
    (await keyDatabasesEquivalent(factory, keyPair.legacyName, keyPair.canonicalName))
  );
}

async function canonicalUseSafeWithoutMigration(
  factory: IDBFactory,
  keyPair: LegacyIndexedDbNamePair
) {
  const [legacy, canonical] = await Promise.all([
    inspectDatabase(factory, keyPair.legacyName),
    inspectDatabase(factory, keyPair.canonicalName),
  ]);
  // Existing canonical ownership is usable even when legacy must be preserved.
  // If only a legacy key exists, generating a new canonical key would strand
  // its ciphertext, so callers must fail closed until the claim can run.
  return canonical.hasValues || !legacy.hasValues;
}

async function withExclusiveNamespaceLocks<T>(
  locks: LegacyNamespaceLockManager | null,
  names: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  if (!locks || names.length === 0) return operation();
  const uniqueNames = [...new Set(names)];
  const visit = async (index: number): Promise<T> => {
    if (index >= uniqueNames.length) return operation();
    let callbackStarted = false;
    try {
      return await locks.request(
        uniqueNames[index],
        { mode: "exclusive" },
        async (lock) => {
          callbackStarted = true;
          if (lock === null) {
            throw new Error(`IndexedDB migration lock '${uniqueNames[index]}' unavailable.`);
          }
          return visit(index + 1);
        }
      );
    } catch (error) {
      if (callbackStarted) throw error;
      throw new Error(`IndexedDB migration lock '${uniqueNames[index]}' failed.`, {
        cause: error,
      });
    }
  };
  return visit(0);
}

/**
 * Migrate one encryption-key provenance together with every data DB protected
 * by it. A raw ciphertext is never merged independently from its key:
 *
 * - legacy key only: atomically claim the empty canonical key DB, then copy data;
 * - canonical key only / no keys: merge only provably plaintext legacy data;
 * - both keys, or sealed bytes without their matching key: change nothing and
 *   preserve both namespaces for recovery.
 *
 * Whole legacy DBs are never deleted during the rolling-upgrade window. Only
 * explicitly configured source records (durable outbox entries) are consumed,
 * and only with a raw-value compare-and-delete after their canonical copy
 * commits. A crash or late old-tab write therefore leaves a recoverable source,
 * never ciphertext rebound to an unrelated canonical key.
 */
export function migrateLegacyIndexedDbProvenance(
  keyPair: LegacyIndexedDbNamePair,
  dataPairs: readonly LegacyIndexedDbDataPair[],
  factory: IDBFactory | undefined = globalThis.indexedDB,
  options: LegacyIndexedDbMigrationOptions = {}
): Promise<LegacyIndexedDbMigrationResult> {
  const migrationKey = keyPair.canonicalName;
  if (!factory || keyPair.legacyName === keyPair.canonicalName) {
    return Promise.resolve("not-needed");
  }
  const locks = resolveNamespaceLocks(options.locks);
  const run = async (): Promise<LegacyIndexedDbMigrationResult> => {
    let canonicalKeyReady = false;
    try {
    const [legacyKey, canonicalKey] = await Promise.all([
      inspectDatabase(factory, keyPair.legacyName),
      inspectDatabase(factory, keyPair.canonicalName),
    ]);
    canonicalKeyReady = canonicalKey.hasValues || !legacyKey.hasValues;
    const suppressedPairs = dataPairs.map(migrationPairSuppressed);
    const [legacyData, canonicalData] = await Promise.all([
      Promise.all(
        dataPairs.map((pair, index) =>
          suppressedPairs[index]
            ? { exists: false, hasSealedValue: false, hasValues: false }
            : inspectDatabase(factory, pair.legacyName, !legacyKey.hasValues)
        )
      ),
      Promise.all(
        dataPairs.map((pair, index) =>
          suppressedPairs[index]
            ? { exists: false, hasSealedValue: false, hasValues: false }
            : inspectDatabase(factory, pair.canonicalName, !canonicalKey.hasValues)
        )
      ),
    ]);
    const hasLegacyData = legacyData.some((state) => state.hasValues);
    const hasLegacyState = legacyKey.hasValues || hasLegacyData;
    if (!hasLegacyState) {
      return "not-needed";
    }

    const keysShareProvenance =
      legacyKey.hasValues && canonicalKey.hasValues
        ? await keyDatabasesEquivalent(factory, keyPair.legacyName, keyPair.canonicalName)
        : false;
    const divergentKeys =
      legacyKey.hasValues && canonicalKey.hasValues && !keysShareProvenance;
    const legacySealedWithoutKey =
      !legacyKey.hasValues && legacyData.some((state) => state.hasSealedValue);
    const canonicalSealedWithoutKey =
      !canonicalKey.hasValues && canonicalData.some((state) => state.hasSealedValue);
    if (divergentKeys || legacySealedWithoutKey || canonicalSealedWithoutKey) {
      return "preserved-conflict";
    }

    if (legacyKey.hasValues && !canonicalKey.hasValues) {
      // Deterministic unit-test seam for the exact inspect→claim race. Product
      // callers never pass it; the target transaction below remains the CAS.
      await options.beforeKeyClaimForTest?.();
      // The read-empty + add happens in one target write transaction. If
      // another tab establishes a canonical key first, the transaction sees
      // it (or loses with ConstraintError) and no ciphertext is merged.
      const claimed = await copyKeyDatabaseIfTargetEmpty(
        factory,
        keyPair.legacyName,
        keyPair.canonicalName
      );
      if (!claimed) {
        const canonicalAfterRace = await inspectDatabase(factory, keyPair.canonicalName);
        if (canonicalAfterRace.hasValues) return "preserved-conflict";
        throw new Error("Canonical encryption key claim did not establish a usable key.");
      }
    }
    // Reaching here means data is plaintext, keys were already equivalent, or
    // the legacy key won the atomic empty-target claim above.
    canonicalKeyReady = true;
    const validateProvenance = () =>
      keyProvenanceStillValid(factory, keyPair, legacyKey.hasValues);
    const exclusiveLockUnavailable =
      !locks &&
      dataPairs.some(
        (pair, index) =>
          !suppressedPairs[index] && pair.requireExclusiveLock && legacyData[index].hasValues
      );
    if (exclusiveLockUnavailable) {
      // Seed only the tiny safety metadata before canonical SDKs can open the
      // new database. In particular, copying the encrypted schema marker keeps
      // RecordCache.ensureSchema() from replacing it with a randomized new
      // ciphertext that could never raw-match on a later lock-capable boot.
      // Payload and source records remain untouched without lock authority.
      for (let index = 0; index < dataPairs.length; index += 1) {
        if (suppressedPairs[index] || !legacyData[index].hasValues) continue;
        const pair = dataPairs[index];
        const seeded = await copyEarlyMetaOnly(
          factory,
          pair.legacyName,
          pair.canonicalName,
          pair.earlyMetaKeys ?? [],
          validateProvenance
        );
        if (!seeded) return "preserved-conflict";
      }
      return "preserved-conflict";
    }

    const protectedIndexes = dataPairs
      .map((pair, index) => (pair.respectLegacyOutboxLiveness ? index : -1))
      .filter((index) => index >= 0);
    const migratableTabs = new Map<number, ReadonlySet<string>>();
    let skippedLiveOrUnknown = false;

    const copyValidateAndConsume = async (): Promise<LegacyIndexedDbMigrationResult> => {
      let testHookRan = false;
      if (!(await validateProvenance())) return "preserved-conflict";
      // Copy and verify in bounded batches. Configured source stores are CAS-
      // consumed immediately after the target and key provenance commit, so
      // both memory and disk growth are bounded by MIGRATION_BATCH_SIZE.
      for (let index = 0; index < dataPairs.length; index += 1) {
        if (!legacyData[index].hasValues) continue;
        const pair = dataPairs[index];
        const copy = await copyDatabase(
          factory,
          pair.legacyName,
          pair.canonicalName,
          {
            beforePostMergeValidation: async () => {
              if (testHookRan) return;
              testHookRan = true;
              await options.beforeProvenanceRecheckForTest?.();
            },
            beforeBatchMergeForTest: options.beforeDataBatchMergeForTest,
            consumeCanonicalConflicts: pair.consumeCanonicalConflicts ?? false,
            consumeStores: pair.consumeStores ?? [],
            earlyMetaKeys: pair.earlyMetaKeys ?? [],
            protectedOutboxTabIds: migratableTabs.get(index),
            validateProvenance,
          }
        );
        if (!copy) return "preserved-conflict";
        if (copy.provenanceConflict) return "preserved-conflict";
        if (copy.skippedProtectedEntries) skippedLiveOrUnknown = true;
      }
      if (!(await validateProvenance())) return "preserved-conflict";
      return skippedLiveOrUnknown ? "preserved-conflict" : "migrated";
    };

    const withProtectedTabLocks = async (offset: number): Promise<LegacyIndexedDbMigrationResult> => {
      if (offset >= protectedIndexes.length) return copyValidateAndConsume();
      const pairIndex = protectedIndexes[offset];
      const pair = dataPairs[pairIndex];
      if (!legacyData[pairIndex].hasValues) return withProtectedTabLocks(offset + 1);
      const locked = await withLegacyOutboxTabLocks(
        factory,
        pair.legacyName,
        resolveNamespaceLocks(options.locks),
        async (tabIds) => {
          migratableTabs.set(pairIndex, tabIds);
          try {
            return await withProtectedTabLocks(offset + 1);
          } finally {
            migratableTabs.delete(pairIndex);
          }
        }
      );
      if (locked.skippedLiveOrUnknown) skippedLiveOrUnknown = true;
      return locked.value === "migrated" && skippedLiveOrUnknown
        ? "preserved-conflict"
        : locked.value;
    };

    const result = await withProtectedTabLocks(0);

    // Keep the legacy key DB as a durable provenance witness. An already-open
    // old tab may enqueue another mutation after this pass; the next boot can
    // prove both keys are equivalent, migrate that late write, and CAS-consume
    // it without a blocked whole-DB deletion racing the old tab.
    return result;
    } catch (error) {
      if (error instanceof LegacyIndexedDbMigrationError) throw error;
      throw new LegacyIndexedDbMigrationError(error, canonicalKeyReady);
    }
  };

  const livenessPairs = dataPairs.filter((pair) => pair.respectLegacyOutboxLiveness);
  const lockNames = [
    ...(options.exclusiveLockName && !options.exclusiveLockAlreadyHeld
      ? [options.exclusiveLockName]
      : []),
    // EdgeBase claimAbandoned() re-keys canonical entries under this sweep
    // lock. Hold it across merge + source CAS so an acknowledged claim cannot
    // make the just-copied target key disappear and leave a replayable source.
    ...livenessPairs.map((pair) => `${pair.canonicalName}::sweep`),
    ...livenessPairs.map((pair) => pair.legacyName),
    ...livenessPairs.map((pair) => `${pair.legacyName}::sweep`),
  ];
  const start = async () => {
    try {
      return await withExclusiveNamespaceLocks(locks, lockNames, run);
    } catch (error) {
      if (error instanceof LegacyIndexedDbMigrationError) throw error;
      const safeToContinue = await canonicalUseSafeWithoutMigration(factory, keyPair).catch(
        () => false
      );
      throw new LegacyIndexedDbMigrationError(error, safeToContinue);
    }
  };
  // A re-key callback already holding the canonical lock must not join a
  // separately queued migration waiting for that same lock (self-deadlock).
  if (options.exclusiveLockAlreadyHeld) return start();
  const existing = indexedDbMigrations.get(migrationKey);
  if (existing) return existing;
  const migration = start().finally(() => {
    indexedDbMigrations.delete(migrationKey);
  });
  indexedDbMigrations.set(migrationKey, migration);
  return migration;
}

// This module is imported first by main.tsx. The synchronous migration runs
// during module evaluation, before the application graph reads browser keys.
migrateLegacyBrowserStorage();

// Keep the literal referenced so static namespace guards can pin the exact
// compatibility alias rather than allow arbitrary old product strings.
void LEGACY_NAMESPACE;
