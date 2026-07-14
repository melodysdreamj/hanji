// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotionImportOnboardingDialog } from "@/components/NotionImportOnboardingDialog";

afterEach(cleanup);

describe("NotionImportOnboardingDialog", () => {
  it("explains the one-time import choice and opens the Notion import flow", () => {
    const onImport = vi.fn();
    render(<NotionImportOnboardingDialog onImport={onImport} onLater={vi.fn()} />);

    expect(screen.getByRole("dialog", { name: "Bring your Notion workspace to Hanji?" })).toBeTruthy();
    expect(screen.getByText(/always start this later from Import in the sidebar/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Import from Notion" }));

    expect(onImport).toHaveBeenCalledTimes(1);
  });

  it("treats escape and the secondary action as the durable later choice", () => {
    const onLater = vi.fn();
    const view = render(
      <NotionImportOnboardingDialog onImport={vi.fn()} onLater={onLater} />,
    );

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Maybe later" }));

    expect(onLater).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
