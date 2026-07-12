import type { Page } from "./types";

export function isPageVerified(page?: Page | null, now = Date.now()) {
  if (!page?.verifiedAt) return false;
  if (!page.verificationExpiresAt) return true;
  const expiresAt = new Date(page.verificationExpiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt > now;
}

export function verificationStateLabel(page?: Page | null) {
  return isPageVerified(page) ? "Verified" : "Unverified";
}
