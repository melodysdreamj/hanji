// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_DATABASE_MUTATION_EVENT,
  PAGE_ROOM_MUTATION_EVENT,
  pageMetaMutationPatch,
  publishLocalDatabaseMutation,
  publishPageRoomMutation,
} from "../../src/lib/pageRoomEvents";

describe("page room events", () => {
  it("keeps page metadata patches small and ignores non-meta fields", () => {
    expect(
      pageMetaMutationPatch({
        icon: "🚀",
        iconType: "emoji",
        properties: { p1: "not sent through page meta" },
        title: "Updated",
      }),
    ).toEqual({
      icon: "🚀",
      iconType: "emoji",
      title: "Updated",
    });
  });

  it("drops invalid icon types from metadata patches", () => {
    expect(
      pageMetaMutationPatch({
        icon: "x",
        iconType: "bad" as never,
        title: "Updated",
      }),
    ).toEqual({
      icon: "x",
      title: "Updated",
    });
  });

  it("publishes page-room and local database events as DOM custom events", () => {
    const pageListener = vi.fn();
    const databaseListener = vi.fn();
    window.addEventListener(PAGE_ROOM_MUTATION_EVENT, pageListener);
    window.addEventListener(LOCAL_DATABASE_MUTATION_EVENT, databaseListener);
    try {
      publishPageRoomMutation({
        kind: "page_meta_changed",
        pageId: "page-1",
        patch: { title: "Live title" },
        targetPageId: "page-1",
      });
      publishLocalDatabaseMutation({
        databaseId: "db-1",
        kind: "database_rows_changed",
        reason: "row_created",
        rowIds: ["row-1"],
      });
    } finally {
      window.removeEventListener(PAGE_ROOM_MUTATION_EVENT, pageListener);
      window.removeEventListener(LOCAL_DATABASE_MUTATION_EVENT, databaseListener);
    }

    expect(pageListener).toHaveBeenCalledTimes(1);
    expect(pageListener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        kind: "page_meta_changed",
        pageId: "page-1",
        patch: { title: "Live title" },
      },
    });
    expect(databaseListener).toHaveBeenCalledTimes(1);
    expect(databaseListener.mock.calls[0]?.[0]).toMatchObject({
      detail: {
        databaseId: "db-1",
        kind: "database_rows_changed",
        rowIds: ["row-1"],
      },
    });
  });
});
