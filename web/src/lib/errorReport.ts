import packageMetadata from "../../package.json";

const REPORT_URL = "https://github.com/melodysdreamj/hanji/issues/new";
const ERROR_CLASSES = new Set([
  "render-crash",
  "site-not-found",
  "site-rate-limited",
  "site-offline",
  "site-unavailable",
  "site-outside-graph",
]);
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const SAFE_REFERENCE = /^HJ-[A-Z0-9]{6,12}-[A-Z0-9]{6}$/;

export type ErrorReportClass =
  | "render-crash"
  | "site-not-found"
  | "site-rate-limited"
  | "site-offline"
  | "site-unavailable"
  | "site-outside-graph";

export interface ErrorReportInput {
  errorClass: ErrorReportClass;
  pathname?: unknown;
  reference?: unknown;
  status?: unknown;
  userAgent?: unknown;
}

function safeVersion(value: unknown) {
  return typeof value === "string" && SAFE_VERSION.test(value)
    ? value
    : "unknown";
}

function routePattern(value: unknown) {
  if (typeof value !== "string") return "other";
  const pathname = value.split(/[?#]/, 1)[0] ?? "";
  if (pathname === "/") return "/";
  if (pathname === "/site" || pathname.startsWith("/site/")) return "/site/:slug";
  if (pathname === "/p" || pathname.startsWith("/p/")) return "/p/:pageId";
  if (pathname === "/share" || pathname.startsWith("/share/")) return "/share/:token";
  if (pathname === "/form" || pathname.startsWith("/form/")) return "/form/:token";
  return "other";
}

function browserFamily(value: unknown) {
  const userAgent = typeof value === "string" ? value : "";
  if (/\bEdg(?:e|A|iOS)?\//i.test(userAgent)) return "Edge";
  if (/\b(?:Chrome|CriOS)\//i.test(userAgent)) return "Chrome";
  if (/\bFirefox\//i.test(userAgent)) return "Firefox";
  if (/\bSafari\//i.test(userAgent) && /\bVersion\//i.test(userAgent)) return "Safari";
  return "Other";
}

function osFamily(value: unknown) {
  const userAgent = typeof value === "string" ? value : "";
  if (/\bAndroid\b/i.test(userAgent)) return "Android";
  if (/\b(?:iPhone|iPad|iPod)\b/i.test(userAgent)) return "iOS";
  if (/\bWindows\b/i.test(userAgent)) return "Windows";
  if (/\b(?:Macintosh|Mac OS X)\b/i.test(userAgent)) return "macOS";
  if (/\bLinux\b/i.test(userAgent)) return "Linux";
  return "Other";
}

function safeStatus(value: unknown) {
  const status = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : null;
}

export function errorStatus(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as { status?: unknown; code?: unknown };
  return safeStatus(record.status) ?? safeStatus(record.code);
}

export function createErrorReference() {
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `HJ-${Date.now().toString(36).toUpperCase()}-${random}`;
}

export function errorReportUrl(input: ErrorReportInput) {
  const errorClass = ERROR_CLASSES.has(input.errorClass)
    ? input.errorClass
    : "render-crash";
  const reference = typeof input.reference === "string" && SAFE_REFERENCE.test(input.reference)
    ? input.reference
    : "unavailable";
  const status = safeStatus(input.status);
  const appVersion = safeVersion(packageMetadata.version);
  const edgeBaseVersion = safeVersion(packageMetadata.dependencies?.["@edge-base/web"]);
  const lines = [
    "Please review this draft before submitting. No report has been sent automatically.",
    "",
    "Diagnostic summary",
    `Reference: ${reference}`,
    `Error class: ${errorClass}`,
    `Route pattern: ${routePattern(input.pathname)}`,
    ...(status ? [`Status: ${status}`] : []),
    `Hanji version: ${appVersion}`,
    `EdgeBase version: ${edgeBaseVersion}`,
    `Browser family: ${browserFamily(input.userAgent)}`,
    `OS family: ${osFamily(input.userAgent)}`,
  ];
  const url = new URL(REPORT_URL);
  url.searchParams.set("title", "[Bug] Hanji error report");
  url.searchParams.set("body", lines.join("\n"));
  return url.toString();
}
