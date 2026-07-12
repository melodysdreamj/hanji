import { useMemo, useSyncExternalStore } from "react";

const ROUTE_CHANGE_EVENT = "hanji:routechange";

type RouteParams = {
  pageId?: string;
  workspaceSlug?: string;
  shareId?: string;
  databaseId?: string;
};

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
  const routePatterns: Array<[keyof RouteParams, RegExp]> = [
    ["pageId", /^\/p\/([^/?#]+)/],
    ["workspaceSlug", /^\/workspace\/([^/?#]+)/],
    ["shareId", /^\/share\/([^/?#]+)/],
    ["databaseId", /^\/database\/([^/?#]+)/],
  ];

  for (const [key, pattern] of routePatterns) {
    const match = pathname.match(pattern);
    if (match?.[1]) return { [key]: decodeURIComponent(match[1]) };
  }

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
