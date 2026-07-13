export type SharedPageErrorKind = "not-found" | "rate-limited" | "offline" | "unavailable";

export function sharedPageErrorKind(error: unknown): SharedPageErrorKind {
  const record = error as {
    status?: unknown;
    code?: unknown;
    slug?: unknown;
    errorCode?: unknown;
    error_code?: unknown;
    message?: unknown;
  } | null;
  const numericStatus = [record?.status, record?.code].find((value) => typeof value === "number");
  const semanticCode = [record?.slug, record?.errorCode, record?.error_code, record?.code]
    .find((value) => typeof value === "string");
  const message = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : "";
  const normalized = `${semanticCode ?? ""} ${message}`.toLowerCase();

  // Public share endpoints intentionally collapse missing/expired/forbidden
  // resources so the UI never becomes an existence oracle.
  if (
    [401, 403, 404, 410].includes(Number(numericStatus)) ||
    /not.?found|expired|revoked|unpublished|invalid.?token|access.?denied|forbidden/.test(normalized)
  ) {
    return "not-found";
  }
  if (Number(numericStatus) === 429 || /rate.?limit|too many requests/.test(normalized)) {
    return "rate-limited";
  }
  if (
    error instanceof TypeError ||
    /failed to fetch|network(?: request)? failed|connection refused|offline/.test(normalized)
  ) {
    return "offline";
  }
  return "unavailable";
}
