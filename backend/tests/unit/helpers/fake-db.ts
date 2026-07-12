export type Row = Record<string, unknown> & { id: string };

export interface FakeQuery<T> {
  page(n: number): FakeQuery<T>;
  limit(n: number): FakeQuery<T>;
  where(field: string, op: string, value: unknown): FakeQuery<T>;
  getList(): Promise<{ items: T[]; hasMore: boolean }>;
}

export interface FakeTable<T> {
  getOne(id: string): Promise<T & { id: string }>;
  insert(data: Partial<T>): Promise<T & { id: string }>;
  update(id: string, data: Partial<T>): Promise<T & { id: string }>;
  delete(id: string): Promise<void>;
  where(field: string, op: string, value: unknown): FakeQuery<T & { id: string }>;
  page(n: number): FakeQuery<T & { id: string }>;
  limit(n: number): FakeQuery<T & { id: string }>;
  getList(): Promise<{ items: Array<T & { id: string }>; hasMore: boolean }>;
}

export type FakeTransactOperation =
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

export interface FakeDb {
  tables: Record<string, Row[]>;
  table<T>(name: string): FakeTable<T>;
  transact(operations: FakeTransactOperation[]): Promise<{ results: Array<Record<string, unknown>> }>;
}

let insertCounter = 0;

// Mirrors the EdgeBaseError shape (`code` = HTTP status) so lib helpers like
// getExisting() can tell a missing row (404) apart from a real failure.
function notFoundError(table: string, id: string): Error & { code: number } {
  return Object.assign(new Error(`${table}/${id} not found`), { code: 404 });
}

// Only the operators product code actually uses are implemented. Anything
// else throws instead of silently degrading to equality — a new operator must
// be modeled here (with runtime semantics) before a test can rely on it.
function matchesWhere(actual: unknown, op: string, expected: unknown): boolean {
  if (op === '==') return expected === null ? actual == null : actual === expected;
  if (op === '!=') return expected === null ? actual != null : actual !== expected;
  if (op === '<=' || op === '<' || op === '>=' || op === '>') {
    if (actual == null || expected == null) return false;
    const left = typeof actual === 'number' ? actual : String(actual);
    const right = typeof expected === 'number' ? expected : String(expected);
    if (op === '<=') return left <= right;
    if (op === '<') return left < right;
    if (op === '>=') return left >= right;
    return left > right;
  }
  throw new Error(`fake-db where(): unsupported operator '${op}'.`);
}

// Mirrors the DO's transact ceiling (edgebase database-do.ts MAX_TRANSACT_OPS)
// including the 400 validation error thrown before any op is applied.
const MAX_TRANSACT_OPS = 500;

// The runtime's default query page size (database-do.ts pagination fallback).
const DEFAULT_PAGE_SIZE = 100;

function withRoutingIndexes(tables: Record<string, Row[]>): Record<string, Row[]> {
  const data = { ...tables };
  if (!data.page_workspace_index && Array.isArray(data.pages)) {
    data.page_workspace_index = data.pages
      .filter((page) => typeof page.id === 'string' && typeof page.workspaceId === 'string')
      .map((page) => ({ id: page.id, workspaceId: page.workspaceId as string }));
  }
  if (!data.page_permission_index && Array.isArray(data.page_permissions)) {
    data.page_permission_index = data.page_permissions
      .filter((permission) => typeof permission.id === 'string' && typeof permission.workspaceId === 'string')
      .map((permission) => ({
        id: permission.id,
        workspaceId: permission.workspaceId as string,
        pageId: permission.pageId,
        principalType: permission.principalType,
        principalId: permission.principalId ?? permission.label,
      }));
  }
  if (!data.share_link_index && Array.isArray(data.share_links)) {
    data.share_link_index = data.share_links
      .filter((link) => typeof link.id === 'string' && typeof link.workspaceId === 'string')
      .map((link) => ({
        id: link.id,
        workspaceId: link.workspaceId as string,
        pageId: link.pageId,
        token: link.token,
        enabled: link.enabled === true,
      }));
  }
  return data;
}

export function fakeDb(tables: Record<string, Row[]> = {}): FakeDb {
  const data = withRoutingIndexes(tables);
  return {
    tables: data,
    // Mirrors EdgeBase db.transact semantics: ordered ops, all-or-nothing
    // (applied to a snapshot, committed only when every op succeeds), and
    // expect assertions that abort with the server's 409-style message.
    async transact(operations: FakeTransactOperation[]) {
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error('transact requires a non-empty operations array.');
      }
      if (operations.length > MAX_TRANSACT_OPS) {
        throw Object.assign(
          new Error(`Transact limit exceeded: ${operations.length} operations (max ${MAX_TRANSACT_OPS}).`),
          { code: 400 },
        );
      }
      const snapshot: Record<string, Row[]> = Object.fromEntries(
        Object.entries(data).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]),
      );
      const tableRows = (name: string) => {
        if (!snapshot[name]) snapshot[name] = [];
        return snapshot[name];
      };
      const results: Array<Record<string, unknown>> = [];
      for (const op of operations) {
        if (op.op === 'expect') {
          // The runtime rejects an unconstrained expect (it would otherwise
          // match every row) as a validation error (database-do.ts).
          if (op.id === undefined && !(Array.isArray(op.where) && op.where.length > 0)) {
            throw Object.assign(
              new Error('transact expect requires an id and/or where conditions.'),
              { code: 400 },
            );
          }
          const matches = tableRows(op.table).filter((row) => {
            if (op.id !== undefined && row.id !== op.id) return false;
            for (const [field, , value] of op.where ?? []) {
              // SQLite stores an omitted nullable schema field as SQL NULL;
              // fake rows omit it as `undefined`. An `expect ... == null`
              // compiles to `IS NULL` in DatabaseDO and must match both here.
              if (value === null ? row[field] != null : row[field] !== value) return false;
            }
            return true;
          });
          if (op.exists && matches.length === 0) {
            throw new Error(`Transaction expectation failed: expected a matching row in "${op.table}".`);
          }
          if (!op.exists && matches.length > 0) {
            throw new Error(`Transaction expectation failed: expected no matching row in "${op.table}".`);
          }
          results.push({ expected: true });
          continue;
        }
        if (op.op === 'insert') {
          insertCounter += 1;
          const id = (op.data.id as string) ?? `${op.table}-${insertCounter}`;
          if (tableRows(op.table).some((row) => row.id === id)) {
            throw Object.assign(new Error(`${op.table}/${id} already exists`), { code: 409 });
          }
          const row = { ...op.data, id } as Row;
          tableRows(op.table).push(row);
          results.push({ inserted: { ...row } });
          continue;
        }
        if (op.op === 'update') {
          const found = tableRows(op.table).find((row) => row.id === op.id);
          // The runtime never throws on a 0-row transact update — it
          // synthesizes { updated: { id, ...data } } (database-do.ts).
          if (!found) {
            results.push({ updated: { ...op.data, id: op.id } });
            continue;
          }
          Object.assign(found, op.data, { id: op.id });
          results.push({ updated: { ...found } });
          continue;
        }
        // Transact delete of a missing id is a runtime no-op success (unlike
        // the single-row DELETE endpoint, which 404s — see table.delete).
        const list = tableRows(op.table);
        const index = list.findIndex((row) => row.id === op.id);
        if (index !== -1) list.splice(index, 1);
        results.push({ deleted: true, id: op.id });
      }
      // Commit: replace table contents in place so existing references stay valid.
      for (const [name, rows] of Object.entries(snapshot)) {
        if (!data[name]) data[name] = [];
        data[name].splice(0, data[name].length, ...rows);
      }
      return { results };
    },
    table<T>(name: string): FakeTable<T> {
      const rows = () => {
        if (!data[name]) data[name] = [];
        return data[name] as unknown as Array<T & { id: string }>;
      };
      const makeQuery = (
        filtered: Array<T & { id: string }>,
        pageNumber: number,
        pageSize: number,
      ): FakeQuery<T & { id: string }> => ({
        page(n: number) {
          return makeQuery(filtered, n, pageSize);
        },
        limit(n: number) {
          return makeQuery(filtered, pageNumber, n);
        },
        // Chained where = AND, mirroring the runtime TableRef.
        where(field: string, op: string, value: unknown) {
          return makeQuery(
            filtered.filter((row) => matchesWhere((row as Record<string, unknown>)[field], op, value)),
            pageNumber,
            pageSize,
          );
        },
        async getList() {
          const start = (pageNumber - 1) * pageSize;
          const items = filtered.slice(start, start + pageSize);
          return { items, hasMore: start + pageSize < filtered.length };
        },
      });
      return {
        async getOne(id: string) {
          const found = rows().find((row) => row.id === id);
          if (!found) throw notFoundError(name, id);
          return found;
        },
        async insert(record: Partial<T>) {
          insertCounter += 1;
          const id = (record as { id?: string }).id ?? `${name}-${insertCounter}`;
          if (rows().some((row) => row.id === id)) {
            throw Object.assign(new Error(`${name}/${id} already exists`), { code: 409 });
          }
          const row = { ...record, id } as T & { id: string };
          rows().push(row);
          return { ...row };
        },
        async update(id: string, patch: Partial<T>) {
          const found = rows().find((row) => row.id === id);
          if (!found) throw notFoundError(name, id);
          Object.assign(found, patch, { id });
          return { ...found };
        },
        // The single-row DELETE endpoint 404s on a missing id (unlike a
        // transact delete op, which is a no-op success) — database-do.ts.
        async delete(id: string) {
          const list = rows();
          const index = list.findIndex((row) => row.id === id);
          if (index === -1) throw notFoundError(name, id);
          list.splice(index, 1);
        },
        where(field: string, op: string, value: unknown) {
          return makeQuery(
            rows().filter((row) => matchesWhere((row as Record<string, unknown>)[field], op, value)),
            1,
            DEFAULT_PAGE_SIZE,
          );
        },
        // Unfiltered query entry points, mirroring the TableRef API where
        // page()/limit()/getList() can be called directly on the table.
        page(n: number) {
          return makeQuery(rows(), n, DEFAULT_PAGE_SIZE);
        },
        limit(n: number) {
          return makeQuery(rows(), 1, n);
        },
        async getList() {
          return makeQuery(rows(), 1, DEFAULT_PAGE_SIZE).getList();
        },
      };
    },
  };
}
