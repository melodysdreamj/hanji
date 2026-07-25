import { useEffect, useState, type RefObject } from "react";

const NEAR_VIEWPORT_ROOT_MARGIN = "800px 0px";

type ActivationCallback = () => void;

const callbacksByTarget = new Map<Element, Set<ActivationCallback>>();
let sharedObserver: IntersectionObserver | null = null;

function releaseSharedObserverIfIdle() {
  if (callbacksByTarget.size > 0 || !sharedObserver) return;
  sharedObserver.disconnect();
  sharedObserver = null;
}

function handleIntersections(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    if (!entry.isIntersecting && entry.intersectionRatio <= 0) continue;
    const callbacks = callbacksByTarget.get(entry.target);
    if (!callbacks) continue;
    callbacksByTarget.delete(entry.target);
    sharedObserver?.unobserve(entry.target);
    for (const activate of callbacks) activate();
  }
  releaseSharedObserverIfIdle();
}

function getSharedObserver() {
  if (sharedObserver) return sharedObserver;
  if (typeof IntersectionObserver !== "function") return null;
  try {
    sharedObserver = new IntersectionObserver(handleIntersections, {
      rootMargin: NEAR_VIEWPORT_ROOT_MARGIN,
    });
  } catch {
    return null;
  }
  return sharedObserver;
}

function observeNearViewport(target: Element, activate: ActivationCallback) {
  const observer = getSharedObserver();
  if (!observer) {
    activate();
    return () => {};
  }

  const callbacks = callbacksByTarget.get(target) ?? new Set<ActivationCallback>();
  const firstSubscriber = callbacks.size === 0;
  callbacks.add(activate);
  callbacksByTarget.set(target, callbacks);
  if (firstSubscriber) observer.observe(target);

  return () => {
    const current = callbacksByTarget.get(target);
    if (!current) return;
    current.delete(activate);
    if (current.size > 0) return;
    callbacksByTarget.delete(target);
    sharedObserver?.unobserve(target);
    releaseSharedObserverIfIdle();
  };
}

/**
 * Activates one exact resource key when its target approaches the viewport.
 * Changing the key requires a fresh intersection; an empty key is already
 * active because it has no storage request to defer.
 */
export function useNearViewportActivation(
  targetRef: RefObject<Element | null>,
  resourceKey: string
) {
  const [activatedKey, setActivatedKey] = useState("");
  const active = !resourceKey || activatedKey === resourceKey;

  useEffect(() => {
    if (!resourceKey || activatedKey === resourceKey) return;
    const target = targetRef.current;
    if (!target) return;
    return observeNearViewport(target, () => setActivatedKey(resourceKey));
  }, [activatedKey, resourceKey, targetRef]);

  return active;
}
