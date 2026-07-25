import { isPublicSharePath, isPublicSitePath } from "@/lib/router";

export interface InitialAuthRestore {
  sessionUserIdHint: string;
  promise: Promise<string>;
}

export function shouldStartInitialAuthRestore(pathname: string): boolean {
  return !isPublicSharePath(pathname)
    && !isPublicSitePath(pathname)
    && pathname !== "/auth"
    && !pathname.startsWith("/auth/");
}

/**
 * Starts the one ordinary-route cookie refresh that may safely overlap catalog
 * loading. The returned promise is the owner: AuthGate must join it rather
 * than starting another refresh after translated React content mounts.
 */
export function startInitialAuthRestore(
  pathname: string,
  sessionUserIdHint: string,
  restore: () => Promise<string>,
): InitialAuthRestore | undefined {
  if (!shouldStartInitialAuthRestore(pathname)) return undefined;
  return {
    sessionUserIdHint,
    promise: restore().catch(() => ""),
  };
}
