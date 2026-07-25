/**
 * Orders stale-while-revalidate reads by when the physical request started,
 * not by when it happened to finish. A forced read intentionally runs beside
 * an older plain read; the older response must not then win merely because it
 * completed last.
 *
 * Application work is serialized per resource so its Zustand update and
 * IndexedDB write-through remain one ordered unit. Definitive denials use an
 * unconditional application turn: revocation must invalidate every older
 * success and purge cached private data even when the denying request itself
 * was started first.
 */

export type ReadApplicationToken = Readonly<{
  denialGeneration: number;
  denialKey: string;
  generation: number;
  key: string;
}>;

let nextReadGeneration = 0;
const latestReadGeneration = new Map<string, number>();
const readDenialGeneration = new Map<string, number>();
const readApplicationTails = new Map<string, Promise<void>>();

function recordReadApplicationGuardDebug(entry: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    if (window.localStorage.getItem("hanji.debugPresence") !== "1") return;
    const debugWindow = window as Window & {
      __hanjiReadApplicationGuardDebug?: Array<Record<string, unknown>>;
    };
    const entries = debugWindow.__hanjiReadApplicationGuardDebug ?? [];
    entries.push({ at: new Date().toISOString(), ...entry });
    debugWindow.__hanjiReadApplicationGuardDebug = entries.slice(-100);
  } catch {
    // Debug-only observation must never affect application ordering.
  }
}

export const readApplicationKey = {
  blocks: (pageId: string) => `blocks:${pageId}`,
  comments: (pageId: string) => `comments:${pageId}`,
  databaseMetadata: (databaseId: string) => `database-metadata:${databaseId}`,
  databaseScope: (databaseId: string) => `database:${databaseId}`,
  databaseRows: (databaseId: string, queryKey: string) =>
    `database-rows:${databaseId}:${queryKey}`,
};

export function beginReadApplication(
  key: string,
  denialKey = key
): ReadApplicationToken {
  const token = {
    denialGeneration: readDenialGeneration.get(denialKey) ?? 0,
    denialKey,
    generation: ++nextReadGeneration,
    key,
  };
  latestReadGeneration.set(key, token.generation);
  if (key.startsWith("blocks:")) {
    recordReadApplicationGuardDebug({
      event: "begin",
      generation: token.generation,
      key,
    });
  }
  return token;
}

/**
 * Reuse a request's start generation for a record discovered in its response.
 * This is needed for embedded database metadata and row-page records whose ids
 * are not known until the containing response arrives.
 */
export function deriveReadApplication(
  source: ReadApplicationToken,
  key: string,
  denialKey = key
): ReadApplicationToken {
  const token = {
    denialGeneration: readDenialGeneration.get(denialKey) ?? 0,
    denialKey,
    generation: source.generation,
    key,
  };
  const current = latestReadGeneration.get(key) ?? 0;
  if (current <= token.generation) latestReadGeneration.set(key, token.generation);
  return token;
}

export function readApplicationIsLatest(token: ReadApplicationToken): boolean {
  return (
    latestReadGeneration.get(token.key) === token.generation &&
    (readDenialGeneration.get(token.denialKey) ?? 0) === token.denialGeneration
  );
}

/**
 * Advance a resource's application generation without starting another read.
 * Local writes use this as a zero-I/O barrier so a response projected before
 * the write cannot apply after the newer optimistic or committed state.
 */
export function invalidateReadApplication(key: string, reason = "unlabelled") {
  const generation = ++nextReadGeneration;
  latestReadGeneration.set(key, generation);
  if (key.startsWith("blocks:")) {
    recordReadApplicationGuardDebug({
      event: "invalidate",
      generation,
      key,
      reason,
    });
  }
}

function enqueueReadApplication(
  token: ReadApplicationToken,
  apply: () => void | Promise<void>,
  requireLatest: boolean
): Promise<boolean> {
  // Metadata and every row query of one database use different latest-value
  // keys but one denial scope. Serialize their application turns on that
  // shared scope so a metadata 403 purge cannot race a row cache write and be
  // followed by private rows being resurrected in IndexedDB.
  const applicationKey = token.denialKey;
  const previous = readApplicationTails.get(applicationKey) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      if (requireLatest && !readApplicationIsLatest(token)) return false;
      await apply();
      return true;
    });
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  readApplicationTails.set(applicationKey, tail);
  void tail.finally(() => {
    if (readApplicationTails.get(applicationKey) === tail) {
      readApplicationTails.delete(applicationKey);
    }
  });
  return run;
}

export function applyLatestRead(
  token: ReadApplicationToken,
  apply: () => void | Promise<void>
): Promise<boolean> {
  return enqueueReadApplication(token, apply, true);
}

export function applyDefinitiveReadDenial(
  token: ReadApplicationToken,
  purge: () => void | Promise<void>
): Promise<boolean> {
  // Starting a denial generation invalidates both this request and every
  // response that started before the denial became known. The purge itself is
  // unconditional; a later read may repopulate only after this queued turn.
  readDenialGeneration.set(
    token.denialKey,
    (readDenialGeneration.get(token.denialKey) ?? 0) + 1
  );
  const denial = beginReadApplication(token.key, token.denialKey);
  return enqueueReadApplication(denial, purge, false);
}

/**
 * Drop per-resource generations when the owning account/data scope is reset.
 * The monotonic counter and active tails intentionally remain: an old in-flight
 * response can never collide with a new token and new work still queues behind
 * an already-running application turn before the stale token is rejected.
 */
export function resetReadApplicationGuards() {
  latestReadGeneration.clear();
  readDenialGeneration.clear();
}
