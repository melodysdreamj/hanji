import { useMemo, useSyncExternalStore } from "react";

const ROUTE_CHANGE_EVENT = "hanji:routechange";

type RouteParams = {
  pageId?: string;
  workspaceSlug?: string;
  shareId?: string;
  databaseId?: string;
};

export type RouteKind = "page" | "workspace" | "share" | "database";

export type RouteInfo =
  | { kind: "home" }
  | { kind: "trash" }
  | { kind: "settings" }
  | { kind: "account" }
  | { kind: "page"; pageId: string }
  | { kind: "workspace"; workspaceSlug: string }
  | { kind: "share"; shareId: string }
  | { kind: "database"; databaseId: string }
  | { kind: "invalid"; routeKind: RouteKind }
  | { kind: "unknown" };

const SEGMENT_ROUTES: ReadonlyArray<{
  kind: RouteKind;
  pattern: RegExp;
  prefix: string;
}> = [
  { kind: "page", pattern: /^\/p\/([^/?#]+)\/?$/, prefix: "/p" },
  { kind: "workspace", pattern: /^\/workspace\/([^/?#]+)\/?$/, prefix: "/workspace" },
  { kind: "share", pattern: /^\/share\/([^/?#]+)\/?$/, prefix: "/share" },
  { kind: "database", pattern: /^\/database\/([^/?#]+)\/?$/, prefix: "/database" },
];

function decodeRouteSegment(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    // Decoded separators would change the path's meaning after matching, while
    // controls and query/hash delimiters never belong in an id/slug segment.
    if (!decoded || /[\/\\?#\u0000-\u001f\u007f]/.test(decoded)) return null;
    return decoded;
  } catch {
    // A stray or incomplete percent escape is an invalid address, not an app
    // exception that should fall through to the root error boundary.
    return null;
  }
}

export function routeInfoFromPath(pathname: string): RouteInfo {
  if (pathname === "/" || pathname === "") return { kind: "home" };
  if (pathname === "/trash" || pathname === "/trash/") return { kind: "trash" };
  if (pathname === "/settings" || pathname === "/settings/") return { kind: "settings" };
  if (pathname === "/account" || pathname === "/account/") return { kind: "account" };

  for (const route of SEGMENT_ROUTES) {
    const match = pathname.match(route.pattern);
    if (match?.[1]) {
      const segment = decodeRouteSegment(match[1]);
      if (!segment) return { kind: "invalid", routeKind: route.kind };
      if (route.kind === "page") return { kind: "page", pageId: segment };
      if (route.kind === "workspace") return { kind: "workspace", workspaceSlug: segment };
      if (route.kind === "share") return { kind: "share", shareId: segment };
      return { kind: "database", databaseId: segment };
    }
    if (pathname === route.prefix || pathname.startsWith(`${route.prefix}/`)) {
      return { kind: "invalid", routeKind: route.kind };
    }
  }

  return { kind: "unknown" };
}

export function isPublicSharePath(pathname: string) {
  return pathname === "/share" || pathname.startsWith("/share/");
}

function getLocationKey() {
  if (typeof window === "undefined") return "/";
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function subscribe(callback: () => void) {
  window.addEventListener("popstate", callback);
  window.addEventListener("hashchange", callback);
  window.addEventListener(ROUTE_CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener("hashchange", callback);
    window.removeEventListener(ROUTE_CHANGE_EVENT, callback);
  };
}

function emitRouteChange(oldUrl: string, newUrl: string) {
  window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
  if (oldUrl !== newUrl && new URL(oldUrl).hash !== new URL(newUrl).hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange", { oldURL: oldUrl, newURL: newUrl }));
  }
}

function navigate(href: string, replace = false) {
  const currentUrl = window.location.href;
  const nextUrl = new URL(href, currentUrl);

  if (nextUrl.origin !== window.location.origin) {
    window.location.href = nextUrl.toString();
    return;
  }

  const nextPath = `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`;
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;

  if (nextPath !== currentPath) {
    if (replace) window.history.replaceState(null, "", nextPath);
    else window.history.pushState(null, "", nextPath);
  }

  emitRouteChange(currentUrl, window.location.href);
}

function useLocationKey() {
  return useSyncExternalStore(subscribe, getLocationKey, () => "/");
}

function routeParamsFromPath(pathname: string): RouteParams {
  const route = routeInfoFromPath(pathname);
  if (route.kind === "page") return { pageId: route.pageId };
  if (route.kind === "workspace") return { workspaceSlug: route.workspaceSlug };
  if (route.kind === "share") return { shareId: route.shareId };
  if (route.kind === "database") return { databaseId: route.databaseId };
  return {};
}

export function usePathname() {
  useLocationKey();
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}

export function useSearchParams() {
  const locationKey = useLocationKey();
  return useMemo(
    () => {
      if (typeof window === "undefined") return new URLSearchParams();
      return new URLSearchParams(window.location.search);
    },
    // `locationKey` isn't read inside the callback, but the callback reads the
    // live `window.location.search`, which the linter can't track. Keeping
    // `locationKey` as a dep is exactly what forces the params to recompute on
    // navigation — removing it would return stale params.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locationKey],
  );
}

export function useParams() {
  const pathname = usePathname();
  return useMemo(() => routeParamsFromPath(pathname), [pathname]);
}

export function useRouter() {
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, true),
      back: () => window.history.back(),
      forward: () => window.history.forward(),
    }),
    []
  );
}
