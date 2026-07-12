// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NotionSelect } from "@/components/database/NotionSelect";

afterEach(cleanup);

const OPTIONS = [
  { value: "table", label: "Table" },
  { value: "board", label: "Board" },
  { value: "chart", label: "Chart", disabled: true },
  { value: "list", label: "List" },
];

function setup(value = "table") {
  const onChange = vi.fn();
  render(<NotionSelect ariaLabel="View type" value={value} options={OPTIONS} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "View type" });
  return { trigger, onChange };
}

describe("NotionSelect", () => {
  it("shows the selected option's label on the trigger", () => {
    const { trigger } = setup("board");
    expect(trigger.textContent).toContain("Board");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens a portal menu with the current option checked", () => {
    const { trigger } = setup("board");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "View type" });
    expect(menu).toBeTruthy();
    const items = screen.getAllByRole("menuitemradio");
    expect(items).toHaveLength(4);
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("commits the clicked option and closes the menu", () => {
    const { trigger, onChange } = setup("table");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "List" }));
    expect(onChange).toHaveBeenCalledWith("list");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("does not commit a disabled option", () => {
    const { trigger, onChange } = setup("table");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Chart" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("skips disabled options during arrow-key navigation and selects with Enter", () => {
    const { trigger, onChange } = setup("board");
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "View type" });
    // Active starts on "Board" (index 1); ArrowDown must skip disabled "Chart".
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("closes on Escape without committing", () => {
    const { trigger, onChange } = setup("table");
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
