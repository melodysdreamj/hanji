// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    deletePageRemote: vi.fn(async (id: string) => [id]),
  };
});

import { TrashView } from "@/components/TrashView";
import { useStore } from "@/lib/store";
import { makePage, resetStore, seedPages, seedUser, TEST_USER } from "./storeTestUtils";

beforeEach(() => {
  resetStore();
  seedUser();
  seedPages([
    makePage({
      id: "trashed-page",
      title: "Removed draft",
      createdBy: "workspace-owner",
      inTrash: true,
      trashedAt: new Date().toISOString(),
    }),
  ]);
  useStore.setState({
    workspace: { id: "ws-1", name: "Workspace", ownerId: "workspace-owner" },
    currentMember: {
      id: "member-editor",
      workspaceId: "ws-1",
      userId: TEST_USER,
      role: "member",
    },
    pageRolesById: { "trashed-page": "edit" },
  });
});

afterEach(cleanup);

describe("TrashView permanent-delete authority", () => {
  it("keeps restore available but hides irreversible actions from edit-only members", () => {
    render(<TrashView />);

    expect(screen.getByRole("button", { name: /Restore Removed draft/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete Removed draft forever/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Empty trash/i })).toBeNull();
  });

  it("shows per-page and bulk irreversible actions for full-access actors", () => {
    useStore.setState({ pageRolesById: { "trashed-page": "full_access" } });

    render(<TrashView />);

    expect(screen.getByRole("button", { name: /Delete Removed draft forever/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Empty trash/i })).toBeTruthy();
  });
});
