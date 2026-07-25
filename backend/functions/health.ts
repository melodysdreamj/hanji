import { defineFunction } from '@edge-base/shared';
import { hanjiEnvValue } from '../lib/hanji-compat';

type HealthProbeOperation =
  | { table: string; op: 'insert'; data: Record<string, unknown> }
  | { table: string; op: 'delete'; id: string }
  | { table: string; op: 'expect'; id: string; exists: boolean };

interface HealthDatabase {
  transact(
    operations: HealthProbeOperation[],
    options: { resultMode: 'compact' },
  ): Promise<{ committed: true; operationCount: number }>;
}

interface HealthContext {
  request?: Request;
  env?: Record<string, unknown>;
  admin: {
    db(namespace: string): HealthDatabase;
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
    const probeId = `health-probe-${crypto.randomUUID()}`;
    const result = await context.admin.db('app').transact([
      { table: 'health_write_probes', op: 'expect', id: probeId, exists: false },
      {
        table: 'health_write_probes',
        op: 'insert',
        data: { id: probeId, probeToken: probeId },
      },
      { table: 'health_write_probes', op: 'delete', id: probeId },
    ], { resultMode: 'compact' });
    if (result.committed !== true || result.operationCount !== 3) {
      throw new Error('Database readiness probe returned an invalid commit receipt.');
    }

    return healthResponse({
      ok: true,
      status: 'ready',
      service: 'hanji-edgebase',
      checks: { database: 'ok' },
      ...(buildSha ? { buildSha } : {}),
      requestId: id,
    }, 200, id);
  } catch (error) {
    console.error('[health] database readiness probe failed:', { requestId: id, error });
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
