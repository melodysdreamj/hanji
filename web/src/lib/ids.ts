// Client-generated ids + fractional ordering.
// EdgeBase honours a client-provided `id` on insert, so we mint ids locally for
// instant optimistic updates and stable cross-row references.

export function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Fractional position between two siblings, so inserts never require reindexing.
 * positionBetween(undefined, undefined) -> 1 (first item)
 * positionBetween(a, undefined) -> a + 1 (append)
 * positionBetween(undefined, b) -> b / 2 (prepend)
 * positionBetween(a, b) -> midpoint
 *
 * Note: repeated midpoint inserts into the *same* gap (~50 in a row) can exhaust
 * double precision and collide. The app overwhelmingly appends (a+1), so this is
 * not hit in practice; a string-based fractional index or sibling reindex would
 * remove the edge entirely if it ever matters.
 */
export function positionBetween(a?: number, b?: number): number {
  if (a == null && b == null) return 1;
  if (a == null) return (b as number) / 2;
  if (b == null) return a + 1;
  return (a + b) / 2;
}
