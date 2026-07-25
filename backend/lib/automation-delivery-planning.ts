import {
  automationRequestHash,
  type AutomationAction,
} from './automation-actions';

export type AutomationDeliveryAction = Extract<
  AutomationAction,
  { type: 'send_notification' | 'send_email' | 'send_webhook' | 'send_slack' }
>;

export type AutomationDeliverySourceType =
  | 'database_automation'
  | 'database_button'
  | 'page_button';

export interface AutomationDeliveryRecord {
  id: string;
  workspaceId: string;
  ownerPageId: string;
  sourceType: AutomationDeliverySourceType;
  sourceId: string;
  executionId?: string;
  databaseId?: string;
  automationId?: string;
  automationRevision?: number;
  actionId: string;
  channel: 'notification' | 'email' | 'webhook' | 'slack';
  scheduledFor: string;
  state: 'pending' | 'retrying' | 'succeeded' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  payload: Record<string, unknown>;
  deliveredAt?: string | null;
  failedAt?: string | null;
  lastError?: string | null;
}

export function isAutomationDeliveryAction(
  action: AutomationAction,
): action is AutomationDeliveryAction {
  return action.type === 'send_notification'
    || action.type === 'send_email'
    || action.type === 'send_webhook'
    || action.type === 'send_slack';
}

function deliveryChannel(
  action: AutomationDeliveryAction,
): AutomationDeliveryRecord['channel'] {
  if (action.type === 'send_notification') return 'notification';
  if (action.type === 'send_email') return 'email';
  if (action.type === 'send_webhook') return 'webhook';
  return 'slack';
}

function deliveryPayload(action: AutomationDeliveryAction): Record<string, unknown> {
  if (action.type === 'send_notification') {
    return { recipientIds: [...action.recipientIds], message: action.message };
  }
  if (action.type === 'send_email') {
    return {
      recipientEmail: action.recipientEmail,
      subject: action.subject,
      message: action.message,
    };
  }
  if (action.type === 'send_webhook') {
    return { url: action.url, body: structuredClone(action.body) };
  }
  return {
    connectionId: action.connectionId,
    channelId: action.channelId,
    message: action.message,
  };
}

export async function automationDeliveryRecord(input: {
  action: AutomationDeliveryAction;
  workspaceId: string;
  ownerPageId: string;
  sourceType: AutomationDeliverySourceType;
  sourceId: string;
  scheduledFor: string;
  executionId?: string;
  databaseId?: string;
  automationId?: string;
  automationRevision?: number;
}): Promise<AutomationDeliveryRecord> {
  const id = input.sourceType === 'database_automation'
    ? await automationRequestHash({
        type: 'database_automation_delivery',
        automationId: input.automationId,
        automationRevision: input.automationRevision,
        actionId: input.action.id,
        scheduledFor: input.scheduledFor,
      })
    : await automationRequestHash({
        type: 'button_automation_delivery',
        executionId: input.executionId,
        actionId: input.action.id,
      });
  return {
    id,
    workspaceId: input.workspaceId,
    ownerPageId: input.ownerPageId,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    ...(input.executionId ? { executionId: input.executionId } : {}),
    ...(input.databaseId ? { databaseId: input.databaseId } : {}),
    ...(input.automationId ? { automationId: input.automationId } : {}),
    ...(input.automationRevision === undefined
      ? {}
      : { automationRevision: input.automationRevision }),
    actionId: input.action.id,
    channel: deliveryChannel(input.action),
    scheduledFor: input.scheduledFor,
    state: 'pending',
    attempts: 0,
    nextAttemptAt: input.scheduledFor,
    payload: deliveryPayload(input.action),
  };
}
