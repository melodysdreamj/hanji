const READ_ACTIVITY_LIMIT = 500;
const UPDATE_READ_STATE_EVENT = "hanji:updates-read-state";

export function updateReadStorageKey(workspaceId?: string) {
  return `hanji.updates.read.${workspaceId || "default"}`;
}

export function updateActivityReadKey(activity: { id: string; at: number }) {
  return `${activity.id}:${activity.at}`;
}

export function compactUpdateReadKeys(keys: Iterable<string>) {
  return Array.from(new Set(keys)).slice(-READ_ACTIVITY_LIMIT);
}

export function readUpdateActivityKeys(workspaceId?: string) {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(updateReadStorageKey(workspaceId)) ?? "[]");
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(
      parsed
        .filter((item): item is string => typeof item === "string")
        .slice(-READ_ACTIVITY_LIMIT),
    );
  } catch {
    return new Set<string>();
  }
}

export function hasUpdateReadState(workspaceId?: string) {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(updateReadStorageKey(workspaceId)) !== null;
  } catch {
    return false;
  }
}

export function writeUpdateActivityKeys(workspaceId: string | undefined, keys: string[]) {
  try {
    window.localStorage.setItem(updateReadStorageKey(workspaceId), JSON.stringify(keys));
  } catch {
    // localStorage can be unavailable in private or constrained contexts.
  }
  window.dispatchEvent(
    new CustomEvent(UPDATE_READ_STATE_EVENT, {
      detail: { workspaceId },
    }),
  );
}

export function subscribeUpdateReadState(workspaceId: string | undefined, listener: () => void) {
  if (typeof window === "undefined") return () => {};
  const onLocalChange = (event: Event) => {
    const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
    if (!detail || detail.workspaceId === workspaceId) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === updateReadStorageKey(workspaceId)) listener();
  };
  window.addEventListener(UPDATE_READ_STATE_EVENT, onLocalChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(UPDATE_READ_STATE_EVENT, onLocalChange);
    window.removeEventListener("storage", onStorage);
  };
}
