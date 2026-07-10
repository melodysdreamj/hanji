import { describe, expect, it } from "vitest";
import { pagePath, pagePathOrWorkspaceRoot } from "@/lib/pagePath";
import type { Page } from "@/lib/types";

function makePage(id: string, patch: Partial<Page> = {}): Page {
  return {
    id,
    workspaceId: "ws",
    parentType: "workspace",
    kind: "page",
    title: `Page ${id}`,
    iconType: "emoji",
    position: 0,
    ...patch,
  } as Page;
}

describe("pagePath", () => {
  it("joins visible ancestor titles from root to parent", () => {
    const root = makePage("root", { title: "Root" });
    const mid = makePage("mid", { title: "Mid", parentId: "root", parentType: "page" });
    const leaf = makePage("leaf", { title: "Leaf", parentId: "mid", parentType: "page" });

    expect(pagePath(leaf, { root, mid, leaf })).toBe("Root / Mid");
  });

  it("does not expose the hidden synthetic Notion import root as a page path", () => {
    const importRoot = makePage("import-root", {
      title: "Imported from Notion",
      properties: { notionImportJobId: "job-1", notionWorkspaceId: null },
    });
    const home = makePage("home", {
      title: "샘플컴퍼니 경영지원 홈페이지",
      parentId: importRoot.id,
      parentType: "page",
      isFavorite: true,
      isPublic: true,
      properties: { notionImportJobId: "job-1", notionPageId: "notion-home" },
    });
    const child = makePage("child", {
      title: "거래처 관리",
      parentId: home.id,
      parentType: "page",
    });
    const pagesById = { [importRoot.id]: importRoot, [home.id]: home, [child.id]: child };

    expect(pagePath(home, pagesById)).toBe("");
    expect(pagePathOrWorkspaceRoot(home, pagesById)).toBe("Workspace root");
    expect(pagePath(child, pagesById)).toBe("샘플컴퍼니 경영지원 홈페이지");
  });
});
