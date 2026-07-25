import type { ButtonClientOutcome } from "./edgebase";
import { pageHref } from "./navigation";

export interface ButtonOutcomeDispatcher {
  navigate: (href: string) => void;
  focusBlock?: (outcome: ButtonClientOutcome) => void;
  openExternal?: (url: string) => void;
}

export function databaseFormViewHref(databaseId: string, viewId: string) {
  const search = new URLSearchParams();
  search.set("v", viewId);
  return pageHref(databaseId, search);
}

function openPublicHttpUrl(url: string) {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return;
  window.open(target.toString(), "_blank", "noopener,noreferrer");
}

export function dispatchButtonClientOutcomes(
  outcomes: readonly ButtonClientOutcome[],
  dispatcher: ButtonOutcomeDispatcher,
) {
  for (const outcome of outcomes) {
    if (outcome.type === "focus_block" && outcome.blockId) {
      dispatcher.focusBlock?.(outcome);
      continue;
    }
    if (outcome.type === "open_page" && outcome.pageId) {
      dispatcher.navigate(pageHref(outcome.pageId));
      continue;
    }
    if (outcome.type === "open_form" && outcome.databaseId && outcome.viewId) {
      dispatcher.navigate(databaseFormViewHref(outcome.databaseId, outcome.viewId));
      continue;
    }
    if (outcome.type === "open_url" && outcome.url) {
      (dispatcher.openExternal ?? openPublicHttpUrl)(outcome.url);
    }
  }
}
