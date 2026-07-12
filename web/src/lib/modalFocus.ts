const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([type="hidden"]):not([disabled])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

export function modalFocusables(root: HTMLElement | null) {
  return Array.from(root?.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR) ?? []).filter(
    (element) => {
      if (
        element.tabIndex < 0 ||
        element.matches(":disabled") ||
        element.getAttribute("aria-disabled") === "true" ||
        element.closest('[aria-hidden="true"], [hidden], [inert], fieldset:disabled')
      ) {
        return false;
      }
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (current === root) break;
      }
      return true;
    }
  );
}

export function trapModalTab(
  event: {
    key: string;
    shiftKey: boolean;
    preventDefault: () => void;
  },
  root: HTMLElement | null
) {
  if (event.key !== "Tab" || !root) return false;
  const focusables = modalFocusables(root);
  if (focusables.length === 0) {
    event.preventDefault();
    root.focus();
    return true;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (!active || !root.contains(active) || !focusables.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
    return true;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
    return true;
  }
  return false;
}

export function isolateBodyForModal(ownedNodes: Array<HTMLElement | null>) {
  const owned = ownedNodes.filter((node): node is HTMLElement => node instanceof HTMLElement);
  const isolated = Array.from(document.body.children)
    .filter((element) => !owned.some((node) => element === node || element.contains(node)))
    .map((element) => {
      const htmlElement = element as HTMLElement;
      const state = {
        element: htmlElement,
        inert: htmlElement.inert,
        ariaHidden: htmlElement.getAttribute("aria-hidden"),
      };
      htmlElement.inert = true;
      htmlElement.setAttribute("aria-hidden", "true");
      return state;
    });

  return () => {
    for (const state of isolated) {
      state.element.inert = state.inert;
      if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
      else state.element.setAttribute("aria-hidden", state.ariaHidden);
    }
  };
}
