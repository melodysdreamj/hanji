export function resolvedViewerTimeZone(): string | undefined {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === "string" && timeZone.trim() ? timeZone.trim() : undefined;
  } catch {
    return undefined;
  }
}
