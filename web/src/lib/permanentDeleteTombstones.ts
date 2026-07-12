const KEY_PREFIX = "hanji.permanentDeletes:";
const CLEANUP_PREFIX = "hanji.permanentDeleteCleanup:";
const MAX_TOMBSTONES_PER_USER = 5_000;

const memory = new Map<string, string[]>();

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function storageKey(userId: string) {
  return `${KEY_PREFIX}${userId}`;
}

function readStored(userId: string): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(validId).slice(-MAX_TOMBSTONES_PER_USER) : [];
  } catch {
    return [];
  }
}

export function permanentDeleteIds(userId: string): Set<string> {
  if (!userId) return new Set();
  const stored = typeof window === "undefined" ? [] : readStored(userId);
  const merged = [...new Set([...(memory.get(userId) ?? []), ...stored])].slice(
    -MAX_TOMBSTONES_PER_USER
  );
  memory.set(userId, merged);
  return new Set(merged);
}

/**
 * Persist server-confirmed permanent ids synchronously before any async cache
 * cleanup. A crash can leave stale IndexedDB bytes, but the next boot and
 * every late network response still filter those ids fail-closed.
 */
export function rememberPermanentDeleteIds(userId: string, ids: Iterable<string>) {
  if (!userId) return new Set<string>();
  const next = [...permanentDeleteIds(userId)];
  for (const id of ids) {
    if (!validId(id)) continue;
    const previous = next.indexOf(id);
    if (previous >= 0) next.splice(previous, 1);
    next.push(id);
  }
  const bounded = next.slice(-MAX_TOMBSTONES_PER_USER);
  memory.set(userId, bounded);
  try {
    window.localStorage.setItem(storageKey(userId), JSON.stringify(bounded));
  } catch {
    // The in-memory fence still protects this tab. Record-cache cleanup runs
    // immediately after this call and removes durable bytes when available.
  }
  return new Set(bounded);
}

export function permanentDeleteUserIdFromStorageKey(key: string | null) {
  return key?.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : "";
}

export function permanentDeleteCacheCleanupPending(userId: string) {
  if (!userId || typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${CLEANUP_PREFIX}${userId}`) === "1";
  } catch {
    return false;
  }
}

export function markPermanentDeleteCacheCleanupPending(userId: string, pending: boolean) {
  if (!userId || typeof window === "undefined") return;
  try {
    if (pending) window.localStorage.setItem(`${CLEANUP_PREFIX}${userId}`, "1");
    else window.localStorage.removeItem(`${CLEANUP_PREFIX}${userId}`);
  } catch {
    // Tombstones still prevent hydration even if this retry hint cannot persist.
  }
}

export function resetPermanentDeleteTombstonesForTests() {
  memory.clear();
}
