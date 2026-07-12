import { describe, expect, it } from "vitest";
import { importedFileTitle } from "@/components/pageMarkdownImport";

describe("importedFileTitle", () => {
  it("preserves a real filename while using the caller's explicit locale fallback", () => {
    expect(importedFileTitle({ name: "tasks.csv" }, "제목 없음")).toBe("tasks");
    expect(importedFileTitle({ name: ".csv" }, "제목 없음")).toBe("제목 없음");
    expect(importedFileTitle({ name: "" }, "Untitled")).toBe("Untitled");
  });
});
