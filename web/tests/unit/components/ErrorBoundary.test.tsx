// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ErrorBoundary } from "@/components/ErrorBoundary";

afterEach(cleanup);

function Boom({ enabled }: { enabled: boolean }) {
  if (enabled) throw new Error("render exploded");
  return <div>content restored</div>;
}

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary scope="test">
        <div>fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("shows a safe alert fallback with a correlation reference when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary scope="test">
        <Boom enabled />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).not.toContain("render exploded");
    expect(alert.textContent).toMatch(/Reference: HJ-/);
    expect(spy.mock.calls.some((call) => String(call[0]).includes("error-boundary:test"))).toBe(true);
    spy.mockRestore();
  });

  it("contains a crash so sibling content survives (Sidebar dialog pattern)", () => {
    // Models Sidebar mounting its dialogs in their own boundary: a dialog
    // render crash must degrade to the fallback, not unmount the whole app.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <div>app shell stays</div>
        <ErrorBoundary scope="import-dialog">
          <Boom enabled />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("app shell stays")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    spy.mockRestore();
  });

  it("recovers when retry is pressed after the failure is fixed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let enabled = true;
    const { rerender } = render(
      <ErrorBoundary scope="test">
        <Boom enabled={enabled} />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeTruthy();

    enabled = false;
    rerender(
      <ErrorBoundary scope="test">
        <Boom enabled={enabled} />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("content restored")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    spy.mockRestore();
  });
});
