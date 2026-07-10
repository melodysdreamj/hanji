// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    changePasswordRemote: vi.fn(async () => undefined),
    currentUserEmail: vi.fn(() => "owner@example.com"),
    currentUserId: vi.fn(() => "melody-user-id"),
    listAuthSessionsRemote: vi.fn(async () => []),
    listMfaFactorsRemote: vi.fn(async () => []),
    updateMyWorkspaceProfileRemote: vi.fn(async () => ({
      currentMember: {
        id: "member-guest",
        workspaceId: "ws-1",
        userId: "melody-user-id",
        role: "guest",
      },
      invitations: [],
      members: [],
    })),
  };
});

import { WorkspaceSettingsDialog } from "@/components/WorkspaceSettingsDialog";
import {
  changePasswordRemote,
  listAuthSessionsRemote,
  listMfaFactorsRemote,
} from "@/lib/edgebase";
import { useStore } from "@/lib/store";
import type { WorkspaceMember } from "@/lib/types";
import { resetStore } from "./storeTestUtils";

if (typeof Element !== "undefined" && !Element.prototype.scrollTo) {
  Element.prototype.scrollTo = () => {};
}

const changePasswordRemoteMock = vi.mocked(changePasswordRemote);
const listAuthSessionsRemoteMock = vi.mocked(listAuthSessionsRemote);
const listMfaFactorsRemoteMock = vi.mocked(listMfaFactorsRemote);

const guestMember: WorkspaceMember = {
  id: "member-guest",
  workspaceId: "ws-1",
  userId: "melody-user-id",
  role: "guest",
};

function seedWorkspace() {
  useStore.setState({
    userId: "melody-user-id",
    workspace: {
      id: "ws-1",
      name: "샘플컴퍼니",
      ownerId: "owner-user",
    },
    workspaces: [
      {
        id: "ws-1",
        name: "샘플컴퍼니",
        ownerId: "owner-user",
      },
    ],
    currentMember: guestMember,
    currentOrganizationMember: undefined,
  });
}

async function flushEffects() {
  await act(async () => {});
}

beforeEach(() => {
  resetStore();
  seedWorkspace();
  changePasswordRemoteMock.mockClear();
  listAuthSessionsRemoteMock.mockClear();
  listMfaFactorsRemoteMock.mockClear();
  listAuthSessionsRemoteMock.mockResolvedValue([]);
  listMfaFactorsRemoteMock.mockResolvedValue([]);
});

afterEach(cleanup);

describe("WorkspaceSettingsDialog account console", () => {
  it("shows the signed-in email and account id when the workspace member profile has no email", async () => {
    render(<WorkspaceSettingsDialog />);
    await flushEffects();

    expect(screen.getByDisplayValue("owner@example.com")).toBeTruthy();
    expect(screen.getByText("Account email")).toBeTruthy();
    expect(screen.getAllByText("owner@example.com").length).toBeGreaterThan(0);
    expect(screen.getByText("Account ID")).toBeTruthy();
    expect(screen.getByText("melody-user-id")).toBeTruthy();
  });

  it("exposes password change controls and submits the current/new password pair", async () => {
    render(<WorkspaceSettingsDialog />);
    await flushEffects();

    fireEvent.click(screen.getByRole("button", { name: "Account security" }));
    await flushEffects();

    fireEvent.change(screen.getByLabelText("Current password"), {
      target: { value: "OldPassword1!" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "NewPassword2!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "NewPassword2!" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await flushEffects();

    expect(changePasswordRemoteMock).toHaveBeenCalledWith({
      currentPassword: "OldPassword1!",
      newPassword: "NewPassword2!",
    });
    expect(screen.getByText("Password changed. Other devices need to sign in again.")).toBeTruthy();
  });
});
