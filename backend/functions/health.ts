import { defineFunction } from '@edge-base/shared';
import { hanjiEnvValue } from '../lib/hanji-compat';

interface TableQuery {
  limit(value: number): TableQuery;
  getList(): Promise<{ items?: unknown[] }>;
}

interface HealthContext {
  request?: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): {
      table(name: string): {
        where(field: string, op: string, value: unknown): TableQuery;
      };
    };
  };
}

function requestId(request?: Request) {
  return (
    request?.headers.get('x-request-id')?.trim() ||
    request?.headers.get('cf-ray')?.trim() ||
    crypto.randomUUID()
  );
}

function healthResponse(body: Record<string, unknown>, status: number, id: string) {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Request-Id': id,
    },
  });
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as HealthContext;
  const id = requestId(context.request);
  const buildSha = hanjiEnvValue(context.env, 'HANJI_BUILD_SHA');
  try {
    await context.admin
      .db('app')
      .table('instance_settings')
      .where('id', '==', 'global')
      .limit(1)
      .getList();

    return healthResponse({
      ok: true,
      status: 'ready',
      service: 'hanji-edgebase',
      checks: { database: 'ok' },
      ...(buildSha ? { buildSha } : {}),
      requestId: id,
    }, 200, id);
  } catch {
    return healthResponse({
      ok: false,
      status: 'not_ready',
      service: 'hanji-edgebase',
      checks: { database: 'error' },
      ...(buildSha ? { buildSha } : {}),
      requestId: id,
    }, 503, id);
  }
});
