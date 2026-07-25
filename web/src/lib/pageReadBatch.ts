// Cache hydration and the first React mount can straddle a short boundary on
// slower clients. Keep the discovery window at the upper edge of the approved
// 200-300ms range so comments and database metadata still share one wire call.
export const PAGE_READ_BATCH_WINDOW_MS = 300;
export const PAGE_READ_BATCH_MAX_ITEMS = 100;

export type PageReadBatchAction =
  | "page"
  | "blocks"
  | "backlinks"
  | "comments"
  | "database"
  | "databaseDependencyEdges";

export type PageReadBatchRequest = Record<string, unknown> & {
  action: PageReadBatchAction;
};

export type PageReadBatchWireRequest = PageReadBatchRequest & {
  id: string;
};

export type PageReadBatchWireResult =
  | { data: unknown; id: string; ok: true }
  | { error: { message: string; status: number }; id: string; ok: false };

export interface PageReadBatchWireResponse {
  results: PageReadBatchWireResult[];
}

type PageReadBatchTransport = (
  requests: PageReadBatchWireRequest[]
) => Promise<PageReadBatchWireResponse>;

type PendingRead = {
  body: PageReadBatchRequest;
  id: string;
  key: string;
  promise: Promise<unknown>;
  reject: (error: unknown) => void;
  resolve: (value: unknown) => void;
};

function normalizedDatabaseRequest(body: PageReadBatchRequest): PageReadBatchRequest {
  if (body.action !== "database") return body;
  const viewIds = Array.from(new Set(
    (Array.isArray(body.viewIds) ? body.viewIds : [])
      .filter((viewId): viewId is string => typeof viewId === "string")
      .map((viewId) => viewId.trim())
      .filter(Boolean)
  )).sort();
  const { viewIds: _viewIds, ...request } = body;
  return viewIds.length > 0 ? { ...request, viewIds } : request;
}

function requestKey(body: PageReadBatchRequest) {
  if (body.action !== "database") return JSON.stringify(body);
  const { viewIds: _viewIds, ...compatibleBody } = body;
  return JSON.stringify(compatibleBody);
}

function mergeDatabaseViewHints(pending: PendingRead, body: PageReadBatchRequest) {
  if (pending.body.action !== "database" || body.action !== "database") return;
  const viewIds = Array.from(new Set([
    ...(Array.isArray(pending.body.viewIds) ? pending.body.viewIds : []),
    ...(Array.isArray(body.viewIds) ? body.viewIds : []),
  ].filter((viewId): viewId is string => typeof viewId === "string"))).sort();
  const { viewIds: _viewIds, ...request } = pending.body;
  pending.body = viewIds.length > 0 ? { ...request, viewIds } : request;
}

function resultError(result: Extract<PageReadBatchWireResult, { ok: false }>) {
  return Object.assign(new Error(result.error.message), {
    code: result.error.status,
    status: result.error.status,
  });
}

/**
 * Collect small page reads for a short fixed window, dedupe identical intents,
 * then drain every queued intent through bounded wire batches without another
 * collection delay. The transport owns network concurrency; this layer owns
 * only request coalescing and result demultiplexing.
 */
export function createPageReadBatcher(
  transport: PageReadBatchTransport,
  options: { maxItems?: number; windowMs?: number } = {}
) {
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? PAGE_READ_BATCH_MAX_ITEMS));
  const windowMs = Math.max(0, Math.floor(options.windowMs ?? PAGE_READ_BATCH_WINDOW_MS));
  const pendingByKey = new Map<string, PendingRead>();
  let queue: PendingRead[] = [];
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function sendChunk(chunk: PendingRead[]) {
    try {
      const response = await transport(
        chunk.map(({ body, id }) => ({ ...body, id }))
      );
      const results = new Map((response.results ?? []).map((result) => [result.id, result]));
      for (const pending of chunk) {
        const result = results.get(pending.id);
        if (!result) {
          pending.reject(new Error(`Page read batch omitted result ${pending.id}.`));
        } else if (result.ok) {
          pending.resolve(result.data);
        } else {
          pending.reject(resultError(result));
        }
      }
    } catch (error) {
      for (const pending of chunk) pending.reject(error);
    } finally {
      for (const pending of chunk) {
        if (pendingByKey.get(pending.key) === pending) pendingByKey.delete(pending.key);
      }
    }
  }

  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    const draining = queue;
    queue = [];
    // Dedupe only intents collected in the same window. Once a read is on the
    // wire, a later force/revalidation request must start a new generation
    // instead of joining a response that began before the refresh signal.
    for (const pending of draining) {
      if (pendingByKey.get(pending.key) === pending) pendingByKey.delete(pending.key);
    }
    for (let offset = 0; offset < draining.length; offset += maxItems) {
      void sendChunk(draining.slice(offset, offset + maxItems));
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(flush, windowMs);
  }

  function request<T>(body: PageReadBatchRequest): Promise<T> {
    const normalizedBody = normalizedDatabaseRequest(body);
    const key = requestKey(normalizedBody);
    const existing = pendingByKey.get(key);
    if (existing) {
      mergeDatabaseViewHints(existing, normalizedBody);
      return existing.promise as Promise<T>;
    }

    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const pending: PendingRead = {
      body: normalizedBody,
      id: `read-${++sequence}`,
      key,
      promise,
      reject,
      resolve,
    };
    pendingByKey.set(key, pending);
    queue.push(pending);
    if (queue.length >= maxItems) flush();
    else schedule();
    return promise as Promise<T>;
  }

  function resetForTests() {
    if (timer) clearTimeout(timer);
    timer = null;
    const error = Object.assign(new Error("Page read batch was reset."), {
      code: 499,
      status: 499,
    });
    for (const pending of pendingByKey.values()) pending.reject(error);
    queue = [];
    pendingByKey.clear();
    sequence = 0;
  }

  return { flush, request, resetForTests };
}
