export function clampedPopoverWidth(requestedWidth: number, viewportWidth: number, margin = 8) {
  return Math.max(0, Math.min(requestedWidth, viewportWidth - margin * 2));
}

export function clampedPopoverLeft(
  requestedLeft: number,
  popoverWidth: number,
  viewportWidth: number,
  margin = 8
) {
  return Math.min(Math.max(margin, requestedLeft), Math.max(margin, viewportWidth - popoverWidth - margin));
}
