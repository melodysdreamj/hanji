import { defineFunction } from '@edge-base/shared';

import type { FunctionContext } from '../lib/app-types';
import { processDatabaseAutomationDeliveryPass } from '../lib/database-automation-delivery';
import {
  nextWorkspaceDatabaseAutomationDueAt,
  selectDatabaseAutomationWorkspaces,
  settleDatabaseAutomationWorkspaceWake,
  type DatabaseAutomationWorkspaceSelection,
} from '../lib/database-automation-routing';
import { processDatabaseAutomationSchedulePass } from '../lib/database-automation-scheduler';

const MAX_SCHEDULE_PASSES_PER_WORKSPACE = 4;
const MAX_DELIVERY_PASSES_PER_WORKSPACE = 4;
const FAILURE_RETRY_MS = 60_000;

interface WorkspaceAutomationRun {
  workspaceId: string;
  processedSchedules: number;
  createdDeliveries: number;
  processedDeliveries: number;
  notifications: number;
  retriedDeliveries: number;
  failedDeliveries: number;
  scheduleHasMore: boolean;
  deliveryHasMore: boolean;
  settlement?: 'updated' | 'deleted' | 'superseded';
  failure?: { workspaceId: string; message: string };
}

type DatabaseAutomationMaintenanceContext = FunctionContext & { data?: unknown };

function scheduledTimestamp(data: unknown) {
  if (!data || typeof data !== 'object') return Date.now();
  const value = (data as Record<string, unknown>).scheduledAt
    ?? (data as Record<string, unknown>).scheduledTime
    ?? (data as Record<string, unknown>).cronTime;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

async function processWorkspace(
  context: DatabaseAutomationMaintenanceContext,
  selected: DatabaseAutomationWorkspaceSelection,
  now: number,
): Promise<WorkspaceAutomationRun> {
  const result: WorkspaceAutomationRun = {
    workspaceId: selected.workspaceId,
    processedSchedules: 0,
    createdDeliveries: 0,
    processedDeliveries: 0,
    notifications: 0,
    retriedDeliveries: 0,
    failedDeliveries: 0,
    scheduleHasMore: false,
    deliveryHasMore: false,
  };
  try {
    for (let pass = 0; pass < MAX_SCHEDULE_PASSES_PER_WORKSPACE; pass += 1) {
      const schedule = await processDatabaseAutomationSchedulePass(
        selected.db,
        selected.workspaceId,
      );
      result.processedSchedules += schedule.processedSchedules;
      result.createdDeliveries += schedule.deliveries;
      result.scheduleHasMore = schedule.hasMore;
      if (schedule.busy || !schedule.hasMore) break;
    }

    for (let pass = 0; pass < MAX_DELIVERY_PASSES_PER_WORKSPACE; pass += 1) {
      const delivery = await processDatabaseAutomationDeliveryPass(
        selected.db,
        selected.workspaceId,
      );
      result.processedDeliveries += delivery.processedDeliveries;
      result.notifications += delivery.notifications;
      result.retriedDeliveries += delivery.retried;
      result.failedDeliveries += delivery.failed;
      result.deliveryHasMore = delivery.hasMore;
      if (delivery.busy || !delivery.hasMore) break;
    }

    const nextDueAt = result.scheduleHasMore || result.deliveryHasMore
      ? new Date(now).toISOString()
      : await nextWorkspaceDatabaseAutomationDueAt(selected.db, selected.workspaceId);
    result.settlement = await settleDatabaseAutomationWorkspaceWake(
      context.admin,
      selected.workspaceId,
      selected.queueGeneration,
      nextDueAt,
      now,
    );
    return result;
  } catch (error) {
    result.failure = { workspaceId: selected.workspaceId, message: errorMessage(error) };
    try {
      result.settlement = await settleDatabaseAutomationWorkspaceWake(
        context.admin,
        selected.workspaceId,
        selected.queueGeneration,
        new Date(now + FAILURE_RETRY_MS).toISOString(),
        now,
      );
    } catch (settlementError) {
      result.failure.message = `${result.failure.message}; wake settlement failed: ${
        errorMessage(settlementError)
      }`;
    }
    return result;
  }
}

export default defineFunction({
  trigger: { type: 'schedule', cron: '* * * * *' },
  handler: async (rawContext) => {
    const context = rawContext as DatabaseAutomationMaintenanceContext;
    const now = scheduledTimestamp(context.data);
    const selection = await selectDatabaseAutomationWorkspaces(context.admin, now);
    const runs = await Promise.all(selection.workspaces.map(
      (selected) => processWorkspace(context, selected, now),
    ));
    return {
      selectedWorkspaces: runs.length,
      dueCandidates: selection.dueCandidates,
      auditCandidates: selection.auditCandidates,
      wakeBound: selection.wakeBound,
      processedSchedules: runs.reduce((sum, run) => sum + run.processedSchedules, 0),
      createdDeliveries: runs.reduce((sum, run) => sum + run.createdDeliveries, 0),
      processedDeliveries: runs.reduce((sum, run) => sum + run.processedDeliveries, 0),
      notifications: runs.reduce((sum, run) => sum + run.notifications, 0),
      retriedDeliveries: runs.reduce((sum, run) => sum + run.retriedDeliveries, 0),
      failedDeliveries: runs.reduce((sum, run) => sum + run.failedDeliveries, 0),
      hasMore: runs.some((run) => run.scheduleHasMore || run.deliveryHasMore),
      failures: runs.flatMap((run) => run.failure ? [run.failure] : []),
    };
  },
});
