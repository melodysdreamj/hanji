import { describe, expect, it } from "vitest";
import {
  isPromotableSyntheticNotionImportChild,
  isSyntheticNotionImportRootPage,
  syntheticNotionImportRootLandingPage,
} from "@/lib/importedNotionUi";
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

describe("synthetic Notion import UI helpers", () => {
  it("recognizes generated import roots independently of the display language", () => {
    const localizedRoot = makePage("root-localized", {
      title: "Localized generated import root",
      properties: { notionImportJobId: "job-localized", notionWorkspaceId: "notion-ws" },
    });
    const ordinaryImportedPage = makePage("ordinary", {
      title: "Imported page",
      properties: { notionImportJobId: "job-localized", notionPageId: "notion-page" },
    });

    expect(isSyntheticNotionImportRootPage(localizedRoot)).toBe(true);
    expect(isSyntheticNotionImportRootPage(ordinaryImportedPage)).toBe(false);
  });

  it("redirects a hidden import root to its favorited imported homepage", () => {
    const root = makePage("root", {
      title: "Imported from Notion",
      properties: { notionImportJobId: "job-1", notionWorkspaceId: null },
    });
    const database = makePage("database", {
      kind: "database",
      title: "가상 데이터 관리",
      parentId: root.id,
      parentType: "page",
      position: 1,
    });
    const home = makePage("home", {
      title: "샘플컴퍼니 경영지원 홈페이지",
      parentId: root.id,
      parentType: "page",
      isFavorite: true,
      position: 20,
      properties: { notionImportJobId: "job-1", notionPageId: "notion-home" },
    });

    expect(isPromotableSyntheticNotionImportChild(database)).toBe(false);
    expect(syntheticNotionImportRootLandingPage(root, { root, database, home })).toBe(home);
  });

  it("falls back to the first titled page child when no favorite exists", () => {
    const root = makePage("root", {
      title: "Imported from Notion",
      properties: { notionImportJobId: "job-1", notionWorkspaceId: null },
    });
    const untitled = makePage("untitled", {
      title: "",
      parentId: root.id,
      parentType: "page",
      position: 1,
    });
    const first = makePage("first", {
      title: "First visible page",
      parentId: root.id,
      parentType: "page",
      position: 2,
    });
    const second = makePage("second", {
      title: "Second visible page",
      parentId: root.id,
      parentType: "page",
      position: 3,
    });

    expect(syntheticNotionImportRootLandingPage(root, { root, untitled, first, second })).toBe(first);
  });
});
