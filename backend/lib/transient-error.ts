const TRANSIENT_INFRASTRUCTURE_MESSAGE =
  /abort|timeout|timed out|fetch failed|network|temporar|connection|socket|service unavailable|worker restarted|broken pipe/i;

function numericErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { status, code } = error as { status?: unknown; code?: unknown };
  if (typeof status === 'number' && Number.isInteger(status)) return status;
  if (typeof code === 'number' && Number.isInteger(code)) return code;
  return undefined;
}

// EdgeBase errors expose an HTTP status, while older transports and native
// fetch/storage failures may expose only a stable message. Keep both shapes in
// one predicate so retry behavior cannot drift between callers.
export function isTransientInfrastructureError(error: unknown): boolean {
  const status = numericErrorStatus(error);
  if (
    status === 408
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500 && status <= 599)
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_INFRASTRUCTURE_MESSAGE.test(message);
}
