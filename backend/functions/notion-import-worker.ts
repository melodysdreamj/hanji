import { defineFunction } from '@edge-base/shared';
import { runServerOwnedNotionImportChunk, type FunctionStorageProxy } from './notion-import';
import {
  drainNotionImportRunQueue,
} from '../lib/notion-import-run-queue';
import type { AdminDbAccessor } from '../lib/workspace-db';

interface FunctionContext {
  admin: AdminDbAccessor;
  storage?: FunctionStorageProxy;
  env?: Record<string, unknown>;
  data?: unknown;
}

// The queue/lease is the durable owner. This schedule is only a bounded wakeup
// consumer; it deliberately does not use waitUntil or assume a particular
// self-host dispatcher identity/delivery implementation.
export default defineFunction({
  trigger: { type: 'schedule', cron: '* * * * *' },
  handler: async (context) => {
    const { admin, storage, env } = context as FunctionContext;
    const result = await drainNotionImportRunQueue(
      admin.db('app'),
      (lease) => runServerOwnedNotionImportChunk({
        admin,
        lease,
        storage,
        env,
      }),
    );
    if (result.processed || result.recovered || result.failed) {
      console.log(`[notion-import-worker] ${JSON.stringify({
        ...result,
      })}`);
    }
    return result;
  },
});
