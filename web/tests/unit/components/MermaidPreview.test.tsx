// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { initializeMermaid, renderMermaid } = vi.hoisted(() => ({
  initializeMermaid: vi.fn(),
  renderMermaid: vi.fn(async (_id: string, source: string) => {
    if (source === "broken diagram") throw new Error("Unexpected token on line 1");
    return { svg: '<svg viewBox="0 0 10 10"><text>Rendered node</text></svg>' };
  }),
}));

vi.mock("mermaid", () => ({
  default: {
    initialize: initializeMermaid,
    render: renderMermaid,
  },
}));

import { MermaidPreview } from "@/components/editor/MermaidPreview";

afterEach(() => {
  cleanup();
  renderMermaid.mockClear();
});

describe("MermaidPreview accessibility", () => {
  it("exposes a rendered diagram name and its source as a text alternative", async () => {
    render(<MermaidPreview source={"graph TD\nA --> B"} blockId="diagram-a" />);

    const diagram = await screen.findByRole("img", { name: "Mermaid diagram" });
    const sourceDescription = screen.getByText("Diagram source: graph TD A --> B");
    expect(diagram.getAttribute("aria-describedby")).toBe(sourceDescription.id);
    expect(diagram.querySelector("svg")?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(renderMermaid).toHaveBeenCalledWith(expect.any(String), "graph TD\nA --> B");
  });

  it("announces syntax errors from an assertive live region", async () => {
    render(<MermaidPreview source="broken diagram" blockId="diagram-b" />);

    const alert = await screen.findByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.getAttribute("aria-atomic")).toBe("true");
    expect(alert.textContent).toContain("The diagram has a syntax error.");
    expect(alert.textContent).toContain("Unexpected token on line 1");
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(1));
  });
});
