export interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

export interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
  // The runtime TableRef supports chained where() (AND); optional so the
  // narrow local interfaces around the codebase stay assignable.
  where?(field: string, op: string, value: unknown): TableQuery<T>;
}

// Narrows a query with an extra equality condition when the underlying query
// supports chaining. Callers must keep their in-memory filter as the source of
// truth — this only reduces how many rows the query returns.
export function narrowWhere<T>(query: TableQuery<T>, field: string, value: unknown): TableQuery<T> {
  return typeof query.where === 'function' ? query.where(field, '==', value) : query;
}

export const DEFAULT_LIST_ALL_MAX_ITEMS = 25_000;
export const ABSOLUTE_LIST_ALL_MAX_ITEMS = 100_000;

export interface ListAllOptions {
  maxItems?: number;
  pageSize?: number;
  label?: string;
  // Large administrative/import materializations must be an explicit call-site
  // decision rather than silently inheriting a 200k-row default.
  allowLargeMaterialization?: boolean;
}

export interface BoundedListResult<T> {
  items: T[];
  /** False when rows beyond maxItems were left unread (items is a prefix). */
  complete: boolean;
}

interface GetOneRef<T> {
  getOne(id: string): Promise<T | null>;
}

// Shared pagination core for listAll/listAllTruncated. The 413 decision needs
// to know whether rows beyond maxItems actually exist — a runtime may return
// short pages (hasMore=true with fewer than pageSize rows) or report hasMore
// on an exactly-full final page, so neither page count nor a bare hasMore flag
// is proof of overflow on its own.
async function listAllBounded<T>(
  query: TableQuery<T>,
  options: ListAllOptions,
): Promise<BoundedListResult<T>> {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_LIST_ALL_MAX_ITEMS));
  if (maxItems > ABSOLUTE_LIST_ALL_MAX_ITEMS) {
    throw new Error(`listAll maxItems cannot exceed ${ABSOLUTE_LIST_ALL_MAX_ITEMS}.`);
  }
  if (maxItems > DEFAULT_LIST_ALL_MAX_ITEMS && options.allowLargeMaterialization !== true) {
    throw new Error('Large listAll materialization requires allowLargeMaterialization: true.');
  }
  const pageSize = Math.min(1_000, Math.max(1, Math.floor(options.pageSize ?? 1_000)));
  const out: T[] = [];
  let complete = true;
  for (let page = 1; ; page += 1) {
    const res = await query.page(page).limit(pageSize).getList();
    const items = res.items ?? [];
    if (items.length === 0) {
      // An empty page with hasMore=true is a pagination-contract violation;
      // continuing would loop forever and breaking would silently truncate.
      if (res.hasMore) {
        throw new Error(
          `${options.label ?? 'Query'} pagination returned an empty page with hasMore set.`,
        );
      }
      break;
    }
    const room = maxItems - out.length;
    if (items.length > room) {
      out.push(...items.slice(0, room));
      complete = false;
      break;
    }
    out.push(...items);
    if (!res.hasMore) break;
    if (out.length >= maxItems) {
      // Budget exhausted with hasMore still set: probe one more page, because
      // an exactly-full final page reports hasMore=true with nothing behind it.
      const probe = await query.page(page + 1).limit(pageSize).getList();
      if ((probe.items ?? []).length > 0) complete = false;
      break;
    }
  }
  return { items: out, complete };
}

export async function listAll<T>(query: TableQuery<T>, options: ListAllOptions = {}): Promise<T[]> {
  const { items, complete } = await listAllBounded(query, options);
  if (!complete) {
    const maxItems = Math.max(1, Math.floor(options.maxItems ?? DEFAULT_LIST_ALL_MAX_ITEMS));
    throw Object.assign(
      new Error(`${options.label ?? 'Query'} materialization limit exceeded (${maxItems} rows).`),
      { status: 413 },
    );
  }
  return items;
}

// Degrading variant for read paths that prefer partial results over a 413
// (workspace search, backlinks): callers must surface `complete:false` to the
// user instead of presenting a truncated set as the whole answer.
export async function listAllTruncated<T>(
  query: TableQuery<T>,
  options: ListAllOptions = {},
): Promise<BoundedListResult<T>> {
  return listAllBounded(query, options);
}

export function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

// Preserves surrounding whitespace for values where trimming would change
// stored content (block text, comment bodies).
export function requireStringRaw(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

// The server-side InternalHttpTransport rethrows DB errors as plain `Error`s
// with only the message ("Record 'x' not found in 'pages'." / "Record x not
// found."), dropping the HTTP status — so a missing row must also be detected
// by message shape. Deliberately narrow: "Table … not found" or "Function …
// not found" are config/routing bugs and keep propagating.
const RECORD_NOT_FOUND_MESSAGE = /^Record '?.*'? not found/;

// EdgeBaseError carries the HTTP status on `code` (with a `status` alias).
// Duck-typed so test fakes can participate without importing the SDK class.
export function isNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, status, message } = error as { code?: unknown; status?: unknown; message?: unknown };
  if (code === 404 || status === 404) return true;
  return typeof message === 'string' && RECORD_NOT_FOUND_MESSAGE.test(message);
}

// Returns null only for a missing record (404). Infrastructure failures
// (network, 5xx, auth) propagate so callers cannot mistake an unavailable
// database for an absent row.
export async function getExisting<T>(tableRef: GetOneRef<T>, id: string): Promise<T | null> {
  try {
    return await tableRef.getOne(id);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId() {
  return crypto.randomUUID();
}

// Mirrors @edge-base/core TransactOperation. db.transact applies the ops
// in order inside one server-side transaction (DO transactionSync / D1 batch);
// `expect` asserts row state at commit time and aborts with a 409-style error
// when unmet, closing check-then-write races.
export type TransactOperation =
  | { table: string; op: 'insert'; data: Record<string, unknown> }
  | { table: string; op: 'update'; id: string; data: Record<string, unknown> }
  | { table: string; op: 'delete'; id: string }
  | {
      table: string;
      op: 'expect';
      id?: string;
      where?: Array<[string, '==', unknown]>;
      exists: boolean;
    };

export interface TransactResult {
  results: Array<Record<string, unknown>>;
}

export interface TransactDb {
  transact(operations: TransactOperation[]): Promise<TransactResult>;
}

// For side-effect writes (notifications, audit events) that must not abort the
// primary mutation but must not fail silently either. Returns false on failure
// so callers can surface a warning.
export async function bestEffort(context: string, work: Promise<unknown>): Promise<boolean> {
  try {
    await work;
    return true;
  } catch (error) {
    console.error(`[best-effort] ${context} failed:`, error);
    return false;
  }
}
