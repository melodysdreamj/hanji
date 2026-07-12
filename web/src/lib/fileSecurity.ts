const ACTIVE_CONTENT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/css",
  "text/ecmascript",
  "text/html",
  "text/javascript",
  "text/xml",
]);

const ACTIVE_CONTENT_EXTENSION_RE =
  /\.(?:cjs|css|hta|htm|html|js|mht|mhtml|mjs|shtml|svg|svgz|xht|xhtml|xml|xsl|xslt)$/i;

export interface FileTypeDescriptor {
  name?: string;
  type?: string;
}

export function normalizedFileContentType(value: string | undefined) {
  return (value ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function isActiveContentFile(file: FileTypeDescriptor) {
  const contentType = normalizedFileContentType(file.type);
  if (ACTIVE_CONTENT_MIME_TYPES.has(contentType) || contentType.endsWith("+xml")) {
    return true;
  }
  return ACTIVE_CONTENT_EXTENSION_RE.test((file.name ?? "").trim());
}

export class UnsafeWorkspaceFileError extends Error {
  readonly code = "unsafe-active-content";

  constructor() {
    super("Active web content files cannot be uploaded.");
    this.name = "UnsafeWorkspaceFileError";
  }
}

export function assertSafeWorkspaceUpload(file: FileTypeDescriptor) {
  if (isActiveContentFile(file)) throw new UnsafeWorkspaceFileError();
}

export function isUnsafeWorkspaceFileError(error: unknown): error is UnsafeWorkspaceFileError {
  return error instanceof UnsafeWorkspaceFileError ||
    (error instanceof Error && error.name === "UnsafeWorkspaceFileError");
}

export function isSafeEmbedTarget(value: string | undefined, appOrigin?: string) {
  const raw = value?.trim() ?? "";
  if (!raw) return false;
  const base = appOrigin || "https://hanji.invalid";
  try {
    const parsed = new URL(raw, base);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.pathname.includes("/api/storage/")) return false;
    if (appOrigin && parsed.origin === new URL(appOrigin).origin) return false;
    // Without a known app origin, relative URLs still resolve to the sentinel
    // base and must not be accepted as embeds.
    if (!appOrigin && parsed.origin === base) return false;
    return true;
  } catch {
    return false;
  }
}
