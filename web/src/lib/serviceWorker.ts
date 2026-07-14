"use client";

// Registers the offline service worker (public/sw.js). Production bundles
// only — the Vite dev server has its own module graph and a worker there
// would only confuse HMR. Kill switch: localStorage
// "hanji.sw.disabled" = "1" unregisters and stops re-registering.

import { i18next } from "@/i18n";
import { onAppInteractiveForOfflineWarm } from "@/lib/appInteractive";
import { useStore } from "@/lib/store";

const DISABLE_KEY = "hanji.sw.disabled";
const WARM_OFFLINE_MESSAGE = "hanji:warm-offline-assets";
const PAUSE_OFFLINE_WARM_MESSAGE = "hanji:pause-offline-assets";
const OFFLINE_WARM_QUIET_MS = 10_000;
let registeredWorker: ServiceWorkerRegistration | undefined;
let offlineWarmRequested = false;
let offlineWarmStarted = false;
let offlineWarmTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
let offlineWarmIdleId: number | undefined;

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
  useStore.getState().notify(i18next.t("serviceWorker:updateReady"), "default", {
    label: i18next.t("serviceWorker:reload"),
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

function warmOfflineAssets(registration: ServiceWorkerRegistration): boolean {
  if (!registration.active) return false;
  registration.active.postMessage({ type: WARM_OFFLINE_MESSAGE });
  return true;
}

function cancelScheduledOfflineWarm() {
  if (offlineWarmTimer !== undefined) {
    globalThis.clearTimeout(offlineWarmTimer);
    offlineWarmTimer = undefined;
  }
  const idleWindow = window as Window & {
    cancelIdleCallback?: (handle: number) => void;
  };
  if (offlineWarmIdleId !== undefined) {
    idleWindow.cancelIdleCallback?.(offlineWarmIdleId);
    offlineWarmIdleId = undefined;
  }
}

function scheduleOfflineWarm() {
  if (!offlineWarmRequested || !registeredWorker || offlineWarmStarted) return;
  cancelScheduledOfflineWarm();
  const run = () => {
    offlineWarmIdleId = undefined;
    void navigator.serviceWorker.ready
      .then((readyRegistration) => {
        if (offlineWarmStarted) return;
        offlineWarmStarted = warmOfflineAssets(readyRegistration);
      })
      .catch(() => {});
  };
  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  };
  offlineWarmTimer = globalThis.setTimeout(() => {
    offlineWarmTimer = undefined;
    if (typeof idleWindow.requestIdleCallback === "function") {
      offlineWarmIdleId = idleWindow.requestIdleCallback(run, { timeout: 10_000 });
    } else run();
  }, OFFLINE_WARM_QUIET_MS);
}

function requestOfflineWarm() {
  offlineWarmRequested = true;
  if (registeredWorker) scheduleOfflineWarm();
}

function postponeOfflineWarmForActivity() {
  if (!offlineWarmRequested || !registeredWorker) return;
  if (offlineWarmStarted) {
    registeredWorker.active?.postMessage({ type: PAUSE_OFFLINE_WARM_MESSAGE });
    offlineWarmStarted = false;
  }
  scheduleOfflineWarm();
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
  onAppInteractiveForOfflineWarm(requestOfflineWarm);
  window.addEventListener("pointerdown", postponeOfflineWarmForActivity, {
    capture: true,
    passive: true,
  });
  window.addEventListener("keydown", postponeOfflineWarmForActivity, { capture: true });
  window.addEventListener("input", postponeOfflineWarmForActivity, { capture: true });
  window.addEventListener("load", () => {
    const warmActiveWorker = () => {
      offlineWarmStarted = false;
      if (registeredWorker) scheduleOfflineWarm();
    };
    navigator.serviceWorker.addEventListener("controllerchange", warmActiveWorker);
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        registeredWorker = registration;
        watchForUpdates(registration);
        scheduleOfflineWarm();
      })
      .catch(() => {
        // Offline support is progressive; registration failure is non-fatal.
      });
  });
}
