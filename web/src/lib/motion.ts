export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

export function motionSafeScrollBehavior(preferred: ScrollBehavior = "smooth"): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : preferred;
}
