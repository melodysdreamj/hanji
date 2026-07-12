import { defineFunction } from '@edge-base/shared';
import { isNotFoundError } from '../lib/table-utils';

// Per-account product state for the signed-in user. Currently carries the
// mustChangePassword flag that instance-admin sets when it issues a
// temporary password.
//
// Clearing is requested by the client after `changePassword` succeeds. That
// is deliberately client-affirmed rather than hooked into the auth layer:
// the flag is hygiene (force rotating an admin-known temporary password),
// not an access control — a user who could lie here already holds valid
// credentials. If EdgeBase grows an afterPasswordChange hook, move the clear
// there.

interface AccountFlags {
  id: string;
  mustChangePassword?: boolean;
  reason?: string | null;
  updatedBy?: string | null;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  insert(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
}

interface FunctionContext {
  auth?: { id?: string } | null;
  request?: Request;
  admin: {
    db(namespace: string): { table<T>(name: string): TableRef<T> };
  };
}

function jsonError(status: number, message: string) {
  return Response.json({ ok: false, message }, { status });
}

async function readFlags(table: TableRef<AccountFlags>, userId: string) {
  try {
    return await table.getOne(userId);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const userId = context.auth?.id;
  if (!userId) return jsonError(401, 'Authentication required.');
  const table = context.admin.db('app').table<AccountFlags>('account_flags');
  const flags = await readFlags(table, userId);
  return Response.json(
    { ok: true, mustChangePassword: flags?.mustChangePassword === true },
    { headers: { 'Cache-Control': 'no-store' } },
  );
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const userId = context.auth?.id;
  if (!userId) return jsonError(401, 'Authentication required.');
  const body = (await context.request?.json().catch(() => ({}))) as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : 'get';
  const table = context.admin.db('app').table<AccountFlags>('account_flags');
  if (action === 'get') {
    const flags = await readFlags(table, userId);
    return Response.json(
      { ok: true, mustChangePassword: flags?.mustChangePassword === true },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  if (action !== 'clearMustChangePassword') {
    return jsonError(400, 'Unknown account state action.');
  }
  const flags = await readFlags(table, userId);
  if (flags?.mustChangePassword === true) {
    await table.update(userId, { mustChangePassword: false, updatedBy: userId });
  }
  return Response.json({ ok: true, mustChangePassword: false });
});
