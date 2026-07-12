"use client";

import { useCallback, useSyncExternalStore } from "react";

export type ThemePref = "light" | "dark" | "system";

const KEY = "hanji:theme";

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* no localStorage (SSR) */
  }
  return "system";
}

export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref === "system") {
    if (typeof window !== "undefined" && window.matchMedia) {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    return "light";
  }
  return pref;
}

export function applyTheme(pref: ThemePref) {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(pref);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#191919" : "#efe9dc");
}

// ── single shared source of truth ──────────────────────────────────────────
// Every useTheme() consumer (AppShell, Sidebar, Settings, the Cmd+Shift+L
// shortcut) previously kept its own useState, so picking Dark in Settings left
// AppShell's copy on "system" and Cmd+Shift+L toggled a stale value. The
// preference now lives in one module-level cell; setThemePref updates it and
// notifies all subscribers, and the OS/cross-tab listeners feed the same cell.
let currentPref: ThemePref | null = null;
const listeners = new Set<() => void>();
let globalListenersInstalled = false;

function readPref(): ThemePref {
  if (currentPref === null) currentPref = getThemePref();
  return currentPref;
}

function emit() {
  for (const listener of listeners) listener();
}

function ensureGlobalListeners() {
  if (globalListenersInstalled || typeof window === "undefined") return;
  globalListenersInstalled = true;
  // OS theme flip: reapply + re-render only while following the system.
  if (window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => {
      if (readPref() === "system") {
        applyTheme("system");
        emit();
      }
    });
  }
  // Cross-tab: another tab changed the preference.
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== KEY) return;
    currentPref = getThemePref();
    applyTheme(currentPref);
    emit();
  });
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  currentPref = pref;
  applyTheme(pref);
  emit();
}

function subscribe(listener: () => void): () => void {
  ensureGlobalListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Theme preference bound to the shared module-level store. The `data-theme`
 * attribute is set before React renders in main.tsx; this hook keeps every
 * consumer in sync when the user, another tab, or the OS changes it.
 */
export function useTheme(): [ThemePref, (pref: ThemePref) => void] {
  const pref = useSyncExternalStore(subscribe, readPref, (): ThemePref => "system");
  const setPref = useCallback((next: ThemePref) => setThemePref(next), []);
  return [pref, setPref];
}
