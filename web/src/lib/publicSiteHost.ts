import { useSyncExternalStore } from "react";

export interface PublicSiteHostState {
  ready: boolean;
  custom: boolean;
}

let state: PublicSiteHostState = { ready: false, custom: false };
const listeners = new Set<() => void>();

export function classifyPublicSiteHost(appHostname: string) {
  const currentHostname = typeof window === "undefined" ? "" : window.location.hostname.toLowerCase();
  const canonicalHostname = appHostname.trim().toLowerCase();
  const next = {
    ready: true,
    // An absent or malformed deployment origin fails closed as the ordinary
    // application host. It must never turn every `/` request into a site-index
    // lookup merely because runtime configuration is incomplete.
    custom: Boolean(canonicalHostname && currentHostname && currentHostname !== canonicalHostname),
  };
  if (next.ready === state.ready && next.custom === state.custom) return;
  state = next;
  for (const listener of listeners) listener();
}

export function rejectPublicSiteHost() {
  if (state.ready && !state.custom) return;
  state = { ready: true, custom: false };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return state;
}

const serverSnapshot: PublicSiteHostState = { ready: false, custom: false };

export function usePublicSiteHost() {
  return useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);
}
