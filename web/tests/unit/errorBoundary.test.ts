// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

import { ErrorBoundary } from "../../src/components/ErrorBoundary";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let shouldThrow = true;

function Bomb() {
  if (shouldThrow) throw new Error("boom");
  return createElement("div", { "data-testid": "recovered" }, "content");
}

describe("ErrorBoundary", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    shouldThrow = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders children when nothing throws", () => {
    shouldThrow = false;
    act(() => {
      root.render(createElement(ErrorBoundary, { scope: "test" }, createElement(Bomb)));
    });
    expect(container.querySelector('[data-testid="recovered"]')).not.toBeNull();
  });

  it("catches a child render error, shows the fallback, and logs the scope", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(createElement(ErrorBoundary, { scope: "test" }, createElement(Bomb)));
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).not.toContain("boom");
    expect(alert?.textContent).toMatch(/Reference: HJ-/);
    expect(
      spy.mock.calls.some((call) => String(call[0]).includes("[error-boundary:test]")),
    ).toBe(true);
    spy.mockRestore();
  });

  it("retry re-renders children after the failure is gone", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    act(() => {
      root.render(createElement(ErrorBoundary, { scope: "test" }, createElement(Bomb)));
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    shouldThrow = false;
    const retry = container.querySelector("button");
    expect(retry).not.toBeNull();
    act(() => {
      retry?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="recovered"]')).not.toBeNull();
    spy.mockRestore();
  });
});
