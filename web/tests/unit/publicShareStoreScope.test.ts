// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    bootstrapWorkspace: vi.fn(async () => {
      throw new Error("Unexpected bootstrap in public share scope test.");
    }),
    updatePageRemote: vi.fn(async () => undefined),
  };
});

import { updatePageRemote } from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { SharedPageResult } from "@/lib/edgebase";
import { makePage, resetStore, seedPages, seedUser, TEST_USER } from "./components/storeTestUtils";

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  seedUser();
});

describe("public share store scope", () => {
  it("replaces private maps instead of merging a public snapshot into them", () => {
    const privatePage = makePage({ id: "private", title: "Private" });
    const publicPage = makePage({ id: "public", title: "Published" });
    seedPages([privatePage]);
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
      activeDataScope: { kind: "workspace", workspaceId: "ws-1" },
      pageRolesById: { [privatePage.id]: "full_access" },
      blocksByPage: { [privatePage.id]: [] },
    });

    useStore.getState().applySharedPageSnapshot(
      {
        page: publicPage,
        pages: [publicPage],
        blocks: [],
        properties: [],
        views: [],
        templates: [],
        navigablePageIds: [publicPage.id],
        shareLink: { id: "share" },
      } as unknown as SharedPageResult,
      "public-token"
    );

    const state = useStore.getState();
    expect(Object.keys(state.pagesById)).toEqual([publicPage.id]);
    expect(state.pagesById[privatePage.id]).toBeUndefined();
    expect(state.pageRolesById).toEqual({});
    expect(state.activeDataScope).toEqual({
      kind: "public_share",
      shareKey: "public-token",
      workspaceId: "ws-1",
    });
  });

  it("keeps store mutations read-only even when the signed-in owner opens a share from the same workspace", () => {
    const publicPage = makePage({ id: "public", title: "Published", createdBy: TEST_USER });
    useStore.setState({
      workspace: { id: "ws-1", name: "Workspace", ownerId: TEST_USER },
    });
    useStore.getState().applySharedPageSnapshot(
      {
        page: publicPage,
        pages: [publicPage],
        blocks: [],
        properties: [],
        views: [],
        templates: [],
        shareLink: { id: "share" },
      } as unknown as SharedPageResult,
      "public-token"
    );

    useStore.getState().updatePage(publicPage.id, { title: "Should not save" }, { debounce: false });

    expect(useStore.getState().pagesById[publicPage.id]?.title).toBe("Published");
    expect(vi.mocked(updatePageRemote)).not.toHaveBeenCalled();
  });
});
