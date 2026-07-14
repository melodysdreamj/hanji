"use client";

const APP_INTERACTIVE_EVENT = "hanji:app-interactive";

/** Signal that user-facing app chrome has rendered and background work may run. */
export function markAppInteractiveForOfflineWarm() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(APP_INTERACTIVE_EVENT));
}

export function onAppInteractiveForOfflineWarm(listener: () => void) {
  window.addEventListener(APP_INTERACTIVE_EVENT, listener);
  return () => window.removeEventListener(APP_INTERACTIVE_EVENT, listener);
}
