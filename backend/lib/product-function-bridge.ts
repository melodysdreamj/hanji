export type ProductFunctionDefinition =
  | ((context: unknown) => Promise<unknown> | unknown)
  | { handler?: (context: unknown) => Promise<unknown> | unknown };

interface ProductFunctionContext {
  request: Request;
}

interface ProductFunctionInvocationOptions {
  url?: string | URL;
  headers?: HeadersInit;
  auth?: unknown;
  unavailableMessage?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function errorMessage(payload: unknown, text: string, status: number) {
  const data = record(payload);
  for (const candidate of [data?.message, data?.error_description, data?.code]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return String(candidate);
  }
  const detail = text.trim().slice(0, 200);
  return detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;
}

export class ProductFunctionInvocationError extends Error {
  readonly status: number;
  readonly code: unknown;
  readonly headers: Headers;
  readonly payload: unknown;

  constructor(options: {
    message: string;
    status: number;
    code?: unknown;
    headers?: HeadersInit;
    payload?: unknown;
  }) {
    super(options.message);
    this.name = 'ProductFunctionInvocationError';
    this.status = options.status;
    this.code = options.code;
    this.headers = new Headers(options.headers);
    this.payload = options.payload;
  }
}

export async function invokeProductFunction<T = unknown, Context extends ProductFunctionContext = ProductFunctionContext>(
  definition: ProductFunctionDefinition,
  context: Context,
  body: Record<string, unknown>,
  options: ProductFunctionInvocationOptions = {},
): Promise<T> {
  const invoke = typeof definition === 'function' ? definition : definition.handler;
  if (typeof invoke !== 'function') {
    throw new ProductFunctionInvocationError({
      message: options.unavailableMessage ?? 'Internal product function handler is unavailable.',
      status: 500,
      payload: null,
    });
  }

  const headers = new Headers(options.headers ?? context.request.headers);
  headers.set('content-type', 'application/json');
  const request = new Request(options.url ?? context.request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const invocationContext = Object.prototype.hasOwnProperty.call(options, 'auth')
    ? { ...context, auth: options.auth, request }
    : { ...context, request };
  const result = await invoke(invocationContext);
  if (!(result instanceof Response)) return result as T;

  const text = await result.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // A successful product function may intentionally return plain text. Keep
    // the same body available on errors for diagnostics and retry decisions.
  }
  if (!result.ok) {
    const data = record(payload);
    throw new ProductFunctionInvocationError({
      message: errorMessage(payload, text, result.status),
      status: result.status,
      code: data?.code,
      headers: result.headers,
      payload,
    });
  }
  return payload as T;
}
