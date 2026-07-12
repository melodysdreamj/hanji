export const PAGE_STARTER_DISMISS_REQUEST = "hanji:page-starter-dismiss-request";

export type PageStarterDismissDetail = {
  pageId?: string;
  blockId?: string;
};

const pendingDismissRequests = new Map<string, string | true>();

export function requestPageStarterDismiss(pageId: string, blockId?: string) {
  pendingDismissRequests.set(pageId, blockId ?? true);

  if (typeof document === "undefined") return;
  document.dispatchEvent(
    new CustomEvent<PageStarterDismissDetail>(PAGE_STARTER_DISMISS_REQUEST, {
      detail: { pageId, blockId },
    })
  );
}

export function consumePendingPageStarterDismiss(pageId: string, blockId?: string) {
  const pendingBlockId = pendingDismissRequests.get(pageId);
  if (!pendingBlockId) return false;
  if (pendingBlockId !== true && pendingBlockId !== blockId) return false;
  pendingDismissRequests.delete(pageId);
  return true;
}
