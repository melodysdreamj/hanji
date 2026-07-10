"use client";

// Registers the offline service worker (public/sw.js). Production bundles
// only — the Vite dev server has its own module graph and a worker there
// would only confuse HMR. Kill switch: localStorage
// "notionlike.sw.disabled" = "1" unregisters and stops re-registering.

import { pickLabels } from "@/lib/i18n";
import { useStore } from "@/lib/store";

const DISABLE_KEY = "notionlike.sw.disabled";

const SW_UPDATE_LABELS = {
  en: {
    updateReady: "A new version of the app is available.",
    reload: "Refresh",
  },
  ko: {
    updateReady: "새 버전의 앱을 사용할 수 있어요.",
    reload: "새로고침",
  },
} as const;

function swDisabled(): boolean {
  try {
    return window.localStorage.getItem(DISABLE_KEY) === "1";
  } catch {
    return false;
  }
}

// The worker self-activates (skipWaiting/clients.claim in sw.js), but an open
// tab keeps running the OLD bundle — and the new precache may no longer hold
// the old hashed chunks it lazy-loads. Tell the user instead of leaving them
// on a stale (and potentially chunk-404ing) UI until a manual reload.
function notifyUpdateReady() {
  const labels = pickLabels(SW_UPDATE_LABELS);
  useStore.getState().notify(labels.updateReady, "default", {
    label: labels.reload,
    onClick: () => window.location.reload(),
  });
}

function watchForUpdates(registration: ServiceWorkerRegistration) {
  const track = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      // "installed" with an existing controller = an UPDATE finished installing
      // (first-ever install has no controller and needs no prompt).
      if (worker.state === "installed" && navigator.serviceWorker.controller) {
        notifyUpdateReady();
      }
    });
  };
  track(registration.installing);
  registration.addEventListener("updatefound", () => track(registration.installing));
}

export function registerServiceWorker() {
  if (typeof window === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  if (import.meta.env.DEV) return;
  if (swDisabled()) {
    void navigator.serviceWorker
      .getRegistration()
      .then((registration) => registration?.unregister())
      .catch(() => {});
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => watchForUpdates(registration))
      .catch(() => {
        // Offline support is progressive; registration failure is non-fatal.
      });
  });
}
