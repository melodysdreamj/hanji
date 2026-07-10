"use client";

// Local data lock (key custody — local-first roadmap §10 final item).
//
// Modes:
// - "device" (default): each durable store seals values under its own
//   non-extractable device key. Invisible UX; protects against casual disk
//   inspection and script key-exfiltration only.
// - "passphrase": ONE per-user data key exists at rest only wrapped by a
//   PBKDF2-derived KEK. Every session must unlock it before ANY durable local
//   layer initializes; skipping runs the session network-only (outbox and
//   record cache disabled — nothing readable, nothing written).
//
// The gate below is what outbox.ts / recordCache.ts await. Mode changes and
// cache clearing are orchestrated in store.ts (this module stays leaf-level
// to avoid import cycles).

import {
  createPassphraseSecretBox,
  passphraseBoxConfigured,
  type SecretBox,
} from "@edge-base/web";

const MODE_KEY = "notionlike.encryption.mode";

export type LocalEncryptionMode = "device" | "passphrase";

export function localEncryptionMode(): LocalEncryptionMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "passphrase" ? "passphrase" : "device";
  } catch {
    return "device";
  }
}

export function setLocalEncryptionMode(mode: LocalEncryptionMode) {
  try {
    if (mode === "passphrase") window.localStorage.setItem(MODE_KEY, "passphrase");
    else window.localStorage.removeItem(MODE_KEY);
  } catch {
    // Local storage is optional; the gate then stays in device mode.
  }
}

export function lockBoxName(userId: string) {
  return `notionlike-lock:${userId}`;
}

export function lockConfigured(userId: string): Promise<boolean> {
  return passphraseBoxConfigured(lockBoxName(userId));
}

/** "device" = per-store device keys; SecretBox = unlocked shared key; null = skipped. */
export type LocalBoxGate = SecretBox | null | "device";

interface Gate {
  promise: Promise<LocalBoxGate>;
  resolve: (value: LocalBoxGate) => void;
  settled: LocalBoxGate | "pending";
}

const gates = new Map<string, Gate>();

// Cross-tab re-key safety: each tab caches its gate once and never re-reads
// MODE_KEY, so after one tab enables (or disables) the passphrase lock, other
// open tabs would keep sealing outbox/record-cache values under their stale
// key — entries that are later dropped as undecryptable. localStorage writes
// raise a "storage" event in every *other* tab, so invalidating the cached
// gates on a MODE_KEY change makes the next seal re-read the current mode.
let modeListenerInstalled = false;

// Cross-tab mode-change subscribers. The lock lib stays leaf-level (no imports
// of outbox/recordCache — that would cycle), so those modules register here to
// invalidate their cached, key-bound adapter instances when another tab flips
// the encryption mode.
type ModeChangeListener = () => void;
const modeChangeListeners = new Set<ModeChangeListener>();

export function onLocalEncryptionModeChange(listener: ModeChangeListener): () => void {
  modeChangeListeners.add(listener);
  return () => {
    modeChangeListeners.delete(listener);
  };
}

function invalidateGatesForModeChange() {
  // A gate left "pending" (this tab was awaiting an unlock/skip decision) has an
  // unresolved promise that outbox/recordCache getters await. Dropping it from
  // the map without resolving would wedge those getters — and the FIFO write
  // chains behind them — forever. Resolve pending gates to null (this tab runs
  // network-only until it re-establishes) so awaiters unblock, THEN clear so the
  // next access re-reads the current mode and rebuilds under the right key.
  for (const gate of gates.values()) {
    if (gate.settled === "pending") {
      gate.settled = null;
      gate.resolve(null);
    }
  }
  gates.clear();
  for (const listener of modeChangeListeners) {
    try {
      listener();
    } catch {
      // A misbehaving subscriber must not block the others.
    }
  }
}

function ensureModeListener() {
  if (modeListenerInstalled) return;
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  modeListenerInstalled = true;
  window.addEventListener("storage", (event) => {
    // key === null fires on localStorage.clear(); treat it as an invalidation
    // too. Otherwise only react to the encryption-mode key.
    if (event.key !== null && event.key !== MODE_KEY) return;
    invalidateGatesForModeChange();
  });
}

function gateFor(userId: string): Gate {
  ensureModeListener();
  const existing = gates.get(userId);
  if (existing) return existing;
  if (!userId || localEncryptionMode() === "device") {
    const gate: Gate = {
      promise: Promise.resolve<LocalBoxGate>("device"),
      resolve: () => {},
      settled: "device",
    };
    gates.set(userId, gate);
    return gate;
  }
  let resolve!: (value: LocalBoxGate) => void;
  const promise = new Promise<LocalBoxGate>((r) => {
    resolve = r;
  });
  const gate: Gate = { promise, resolve, settled: "pending" };
  gates.set(userId, gate);
  return gate;
}

/** Blocks (in passphrase mode) until the user unlocks or skips. */
export function awaitLocalBox(userId: string): Promise<LocalBoxGate> {
  return gateFor(userId).promise;
}

/** Non-blocking view for boot-time fast paths. */
export function localBoxIfSettled(userId: string): LocalBoxGate | "pending" {
  return gateFor(userId).settled;
}

export function localLockPending(userId: string): boolean {
  return gateFor(userId).settled === "pending";
}

export async function unlockLocalData(
  userId: string,
  passphrase: string,
  options?: { iterations?: number }
): Promise<"ok" | "unavailable" | "wrong-passphrase"> {
  const result = await createPassphraseSecretBox(lockBoxName(userId), passphrase, options);
  if ("error" in result) return result.error;
  const gate = gateFor(userId);
  gate.settled = result.box;
  gate.resolve(result.box);
  return "ok";
}

/** Continue network-only: the durable layers stay disabled for this session. */
export function skipLocalLock(userId: string) {
  const gate = gateFor(userId);
  if (gate.settled === "pending") {
    gate.settled = null;
    gate.resolve(null);
  }
}

/** Used by mode-change orchestration after layers were reinitialized. */
export function primeUnlockedGate(userId: string, box: SecretBox) {
  const gate: Gate = {
    promise: Promise.resolve<LocalBoxGate>(box),
    resolve: () => {},
    settled: box,
  };
  gates.set(userId, gate);
}

export function resetGateToDevice(userId: string) {
  const gate: Gate = {
    promise: Promise.resolve<LocalBoxGate>("device"),
    resolve: () => {},
    settled: "device",
  };
  gates.set(userId, gate);
}

export function resetLocalLockForTests() {
  gates.clear();
}
