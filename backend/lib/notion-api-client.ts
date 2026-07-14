import { NOTION_API_BASE } from './notion-import-credentials';

export const NOTION_REQUEST_MAX_ATTEMPTS = 8;
const NOTION_REQUEST_RETRY_BASE_DELAY_MS = 1_000;
const NOTION_REQUEST_RETRY_MAX_DELAY_MS = 30_000;
const NOTION_MIN_REQUEST_INTERVAL_MS = 350;
const NOTION_REQUEST_SCHEDULE_TTL_MS = 60 * 60 * 1000;
const NOTION_REQUEST_SCHEDULE_MAX_ENTRIES = 2_048;
const NOTION_REQUEST_TIMEOUT_MS = 30_000;

export class NotionApiError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;

  constructor(message: string, options: { status: number; code?: string; retryAfterMs?: number }) {
    super(message);
    this.name = 'NotionApiError';
    this.status = options.status;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type NotionRequestRetryInfo = {
  path: string;
  method: 'GET' | 'POST';
  status?: number;
  code?: string;
  attempt: number;
  nextAttempt: number;
  delayMs: number;
  message: string;
};

export type NotionRequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  query?: Record<string, string | number | boolean | undefined>;
  apiBase?: string;
  onRetry?: (info: NotionRequestRetryInfo) => void;
};

const notionRequestSchedule = new Map<string, number>();
let notionRequestScheduleHmacKey: Promise<CryptoKey> | undefined;

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionRequestScheduleKey(token: string) {
  notionRequestScheduleHmacKey ??= crypto.subtle.generateKey(
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const key = await notionRequestScheduleHmacKey;
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function pruneNotionRequestSchedule(
  schedule: Map<string, number>,
  now: number,
  ttlMs: number,
  maxEntries: number,
) {
  const staleBefore = now - Math.max(0, ttlMs);
  for (const [key, nextAt] of schedule) {
    if (nextAt < staleBefore) schedule.delete(key);
  }

  const boundedMax = Math.max(0, Math.floor(maxEntries));
  if (schedule.size <= boundedMax) return;
  const oldest = Array.from(schedule.entries()).sort((left, right) => left[1] - right[1]);
  for (let index = 0; index < oldest.length - boundedMax; index += 1) {
    schedule.delete(oldest[index][0]);
  }
}

function notionApiHostIsReal(apiBase: string | undefined) {
  try {
    const host = new URL(apiBase ?? NOTION_API_BASE).hostname;
    return host === 'api.notion.com';
  } catch {
    return false;
  }
}

export function reserveNotionRequestSlot(
  schedule: Map<string, number>,
  token: string,
  now: number,
  minIntervalMs: number,
): number {
  if (minIntervalMs <= 0) return 0;
  const previous = schedule.get(token) ?? 0;
  const slot = Math.max(now, previous);
  schedule.set(token, slot + minIntervalMs);
  return Math.max(0, slot - now);
}

async function throttleNotionRequest(token: string, apiBase: string | undefined) {
  if (!notionApiHostIsReal(apiBase)) return;
  const now = Date.now();
  pruneNotionRequestSchedule(
    notionRequestSchedule,
    now,
    NOTION_REQUEST_SCHEDULE_TTL_MS,
    NOTION_REQUEST_SCHEDULE_MAX_ENTRIES - 1,
  );
  const scheduleKey = await notionRequestScheduleKey(token);
  const waitMs = reserveNotionRequestSlot(
    notionRequestSchedule,
    scheduleKey,
    now,
    NOTION_MIN_REQUEST_INTERVAL_MS,
  );
  if (waitMs > 0) await wait(waitMs);
}

export function notionIsoTimestamp(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

function retryAfterMs(value: string | null) {
  if (!value || !value.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function isRetryableNotionStatus(status: number) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function notionRetryDelay(error: NotionApiError, attempt: number) {
  if (error.status === 429) {
    return error.retryAfterMs ?? Math.min(2_000 * (2 ** attempt), NOTION_REQUEST_RETRY_MAX_DELAY_MS);
  }
  return error.retryAfterMs ?? Math.min(
    NOTION_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attempt),
    NOTION_REQUEST_RETRY_MAX_DELAY_MS,
  );
}

function reportNotionRequestRetry(
  options: NotionRequestOptions,
  input: {
    path: string;
    method: 'GET' | 'POST';
    attempt: number;
    delayMs: number;
    error: unknown;
  },
) {
  if (!options.onRetry) return;
  const error = input.error;
  options.onRetry({
    path: input.path,
    method: input.method,
    status: error instanceof NotionApiError ? error.status : undefined,
    code: error instanceof NotionApiError ? error.code : undefined,
    attempt: input.attempt + 1,
    nextAttempt: input.attempt + 2,
    delayMs: input.delayMs,
    message: error instanceof Error ? error.message : String(error),
  });
}

export async function notionErrorFromResponse(response: Response) {
  let message = `Notion API request failed with ${response.status}.`;
  let code: string | undefined;
  try {
    const error = (await response.json()) as { message?: string; code?: string };
    if (typeof error.message === 'string' && error.message.trim()) message = error.message.trim();
    if (typeof error.code === 'string' && error.code.trim()) code = error.code.trim();
  } catch {
    try {
      const text = await response.text();
      if (text.trim()) message = text.trim();
    } catch {
      // Ignore body parsing failures.
    }
  }
  return new NotionApiError(message, {
    status: response.status,
    code,
    retryAfterMs: retryAfterMs(response.headers.get('Retry-After')),
  });
}

export async function notionRequest(
  token: string,
  path: string,
  apiVersion: string,
  options: NotionRequestOptions = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${(options.apiBase ?? NOTION_API_BASE).replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const method = options.method ?? (options.body ? 'POST' : 'GET');
  const body = options.body ? JSON.stringify(options.body) : undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt < NOTION_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      await throttleNotionRequest(token, options.apiBase);
      const response = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Notion-Version': apiVersion,
        },
        body,
        signal: AbortSignal.timeout(NOTION_REQUEST_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = await response.json();
        return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      }

      const error = await notionErrorFromResponse(response);
      lastError = error;
      if (!isRetryableNotionStatus(error.status) || attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
      const delayMs = notionRetryDelay(error, attempt);
      reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
      await wait(delayMs);
    } catch (error) {
      lastError = error;
      if (error instanceof NotionApiError) {
        if (!isRetryableNotionStatus(error.status) || attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
        const delayMs = notionRetryDelay(error, attempt);
        reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
        await wait(delayMs);
        continue;
      }
      if (attempt >= NOTION_REQUEST_MAX_ATTEMPTS - 1) throw error;
      const delayMs = Math.min(
        NOTION_REQUEST_RETRY_BASE_DELAY_MS * (2 ** attempt),
        NOTION_REQUEST_RETRY_MAX_DELAY_MS,
      );
      reportNotionRequestRetry(options, { path, method, attempt, delayMs, error });
      await wait(delayMs);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError ?? 'Notion API request failed.'));
}

export async function safeNotionRequest(
  token: string,
  path: string,
  apiVersion: string,
  options: NotionRequestOptions = {},
) {
  try {
    return { ok: true as const, data: await notionRequest(token, path, apiVersion, options) };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
      status: error instanceof NotionApiError ? error.status : undefined,
      retryable:
        error instanceof NotionApiError
          ? isRetryableNotionStatus(error.status)
          : true,
    };
  }
}
