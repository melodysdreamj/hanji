import type { FakeDb } from './fake-db';

// Invokes an HTTP function the way the EdgeBase runtime does: POST exports are
// `{ trigger, handler }` objects, and the handler receives `{ auth, admin,
// request, storage }`. Success paths return plain objects; error paths return
// a `Response` from the function's own jsonError helper.
export type FunctionHandler = (context: unknown) => Promise<unknown>;

export function handlerOf(definition: unknown): FunctionHandler {
  const handler = (definition as { handler?: FunctionHandler }).handler;
  if (typeof handler !== 'function') {
    throw new Error('Function definition has no handler.');
  }
  return handler;
}

export function functionContext(db: FakeDb, userId: string | null, body: unknown) {
  return {
    auth: userId ? { id: userId, email: `${userId}@example.com` } : null,
    admin: { db: () => db },
    request: new Request('http://localhost:8787/functions/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
  };
}

export async function callFunction(
  definition: unknown,
  db: FakeDb,
  userId: string | null,
  body: unknown,
): Promise<unknown> {
  return handlerOf(definition)(functionContext(db, userId, body));
}

export async function expectErrorResponse(result: unknown, status: number, messagePart: string) {
  if (!(result instanceof Response)) {
    throw new Error(`Expected an error Response, got: ${JSON.stringify(result)}`);
  }
  const payload = (await result.json()) as { code?: number; message?: string };
  if (result.status !== status) {
    throw new Error(
      `Expected status ${status}, got ${result.status} (message: ${payload.message ?? ''})`,
    );
  }
  if (!payload.message || !payload.message.includes(messagePart)) {
    throw new Error(`Expected message containing "${messagePart}", got "${payload.message ?? ''}"`);
  }
}
