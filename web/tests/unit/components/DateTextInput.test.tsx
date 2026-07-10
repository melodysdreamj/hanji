// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { DateTextInput } from "@/components/database/DateTextInput";

afterEach(cleanup);

function setup(value: unknown = null) {
  const onChange = vi.fn();
  render(<DateTextInput value={value} onChange={onChange} ariaLabel="Due" />);
  const input = screen.getByLabelText("Due") as HTMLInputElement;
  return { input, onChange };
}

describe("DateTextInput", () => {
  it("renders a stored date key in the display format", () => {
    const { input } = setup("2026-07-04");
    expect(input.value).toBe("Jul 4, 2026");
  });

  it("commits an ISO date key on blur", () => {
    const { input, onChange } = setup(null);
    fireEvent.change(input, { target: { value: "2026-01-15" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("2026-01-15");
  });

  it("resolves short numeric drafts against the stored year", () => {
    const { input, onChange } = setup("2024-03-01");
    fireEvent.change(input, { target: { value: "7/4" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith("2024-07-04");
  });

  it("commits null when cleared", () => {
    const { input, onChange } = setup("2026-07-04");
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("reverts to the previous value on unparseable input", () => {
    const { input, onChange } = setup("2026-07-04");
    fireEvent.change(input, { target: { value: "someday" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("Jul 4, 2026");
  });

  it("discards the draft on Escape and never commits the abandoned value", () => {
    const { input, onChange } = setup("2026-07-04");
    fireEvent.change(input, { target: { value: "2030-01-01" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    // The blur after Escape re-commits the unchanged source, never the draft.
    expect(onChange.mock.calls.every((call) => call[0] === "2026-07-04")).toBe(true);
    expect(input.value).toBe("Jul 4, 2026");
  });
});
