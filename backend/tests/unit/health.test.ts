import { describe, expect, it } from 'vitest';

import { GET } from '../../functions/health';
import { fakeDb } from './helpers/fake-db';
import { handlerOf } from './helpers/function-context';

describe('product readiness health', () => {
  it('reports database readiness, request identity, and the deployed revision', async () => {
    const response = await handlerOf(GET)({
      admin: { db: () => fakeDb({ instance_settings: [] }) },
      env: { NOTIONLIKE_BUILD_SHA: 'abc123' },
      request: new Request('https://app.example.com/api/functions/health', {
        headers: { 'x-request-id': 'request-1' },
      }),
    }) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('request-1');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: 'ready',
      buildSha: 'abc123',
      requestId: 'request-1',
      checks: { database: 'ok' },
    });
  });

  it('returns 503 without leaking infrastructure errors when the database is unavailable', async () => {
    const response = await handlerOf(GET)({
      admin: {
        db: () => ({
          table: () => ({
            where: () => ({
              limit: () => ({
                getList: async () => {
                  throw new Error('private database hostname and credentials');
                },
              }),
            }),
          }),
        }),
      },
      request: new Request('https://app.example.com/api/functions/health'),
    }) as Response;

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain('not_ready');
    expect(body).not.toContain('private database hostname');
  });
});
