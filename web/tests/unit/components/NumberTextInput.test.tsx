// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NumberTextInput, parseNumberDraft } from "@/components/database/NumberTextInput";

afterEach(cleanup);

function setup(value: unknown = "") {
  const onChange = vi.fn();
  render(<NumberTextInput value={value} onChange={onChange} ariaLabel="Amount" />);
  const input = screen.getByLabelText("Amount") as HTMLInputElement;
  return { input, onChange };
}

describe("parseNumberDraft", () => {
  it("strips formatting characters before parsing", () => {
    expect(parseNumberDraft("1,234")).toBe(1234);
    expect(parseNumberDraft("$99")).toBe(99);
    expect(parseNumberDraft("₩1 000")).toBe(1000);
  });

  it("returns null for blank and undefined for garbage", () => {
    expect(parseNumberDraft("   ")).toBeNull();
    expect(parseNumberDraft("abc")).toBeUndefined();
  });
});

describe("NumberTextInput", () => {
  it("commits a parsed number on blur", () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: "1,500" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(1500);
  });

  it("commits null when cleared", () => {
    const { input, onChange } = setup(42);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it("reverts to the source value on unparseable input without calling onChange", () => {
    const { input, onChange } = setup(42);
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe("42");
  });

  it("commits on Enter", () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it("discards the draft on Escape and never commits the abandoned value", () => {
    const { input, onChange } = setup(42);
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    // The blur after Escape re-commits the unchanged source, never the draft.
    expect(onChange.mock.calls.every((call) => call[0] === 42)).toBe(true);
    expect(input.value).toBe("42");
  });

  it("re-syncs the draft when the external value changes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<NumberTextInput value={1} onChange={onChange} ariaLabel="Amount" />);
    const input = screen.getByLabelText("Amount") as HTMLInputElement;
    expect(input.value).toBe("1");
    rerender(<NumberTextInput value={2} onChange={onChange} ariaLabel="Amount" />);
    expect(input.value).toBe("2");
  });
});
