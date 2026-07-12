import { describe, expect, it } from "vitest";
import { canEditPage, canManagePage, effectivePageRole } from "@/lib/permissions";
import type { Page, Workspace } from "@/lib/types";

const workspace: Workspace = {
  id: "ws",
  name: "Workspace",
  ownerId: "owner",
};

function makePage(id: string, patch: Partial<Page> = {}): Page {
  return {
    id,
    workspaceId: workspace.id,
    parentType: "workspace",
    kind: "page",
    title: id,
    iconType: "none",
    position: 0,
    ...patch,
  } as Page;
}

describe("permissions", () => {
  it("fails closed when owner metadata is missing", () => {
    const ownerless = { ...workspace, ownerId: undefined };
    const page = makePage("ownerless");

    expect(
      effectivePageRole({ page, pagesById: { [page.id]: page }, workspace: ownerless, userId: "anyone" })
    ).toBeUndefined();
  });

  it("does not apply current-workspace authority to a foreign/public page", () => {
    const foreign = makePage("foreign", {
      workspaceId: "other-workspace",
      createdBy: "owner",
    });

    expect(
      canEditPage({
        page: foreign,
        pagesById: { [foreign.id]: foreign },
        workspace,
        userId: "owner",
      })
    ).toBe(false);
  });

  it("ignores a member record from a different workspace", () => {
    const page = makePage("page");
    expect(
      canEditPage({
        page,
        pagesById: { [page.id]: page },
        workspace: { ...workspace, ownerId: "someone-else" },
        currentMember: {
          id: "member",
          workspaceId: "other-workspace",
          userId: "invitee",
          role: "admin",
        },
        userId: "invitee",
      })
    ).toBe(false);
  });

  it("inherits direct page edit access to nested database rows", () => {
    const root = makePage("root");
    const database = makePage("database", {
      parentId: root.id,
      parentType: "page",
      kind: "database",
    });
    const row = makePage("row", {
      parentId: database.id,
      parentType: "database",
    });

    expect(
      canEditPage({
        page: row,
        pagesById: { [root.id]: root, [database.id]: database, [row.id]: row },
        pageRoles: { [root.id]: "edit" },
        workspace,
        userId: "invitee",
      })
    ).toBe(true);
  });

  it("does not treat an ancestor role as editable without the page ancestry", () => {
    const root = makePage("root");
    const database = makePage("database", {
      parentId: root.id,
      parentType: "page",
      kind: "database",
    });
    const row = makePage("row", {
      parentId: database.id,
      parentType: "database",
    });

    expect(
      effectivePageRole({
        page: row,
        pageRoles: { [root.id]: "edit" },
        workspace,
        userId: "invitee",
      })
    ).toBeUndefined();
  });

  it("reserves manage authority for owners, active creators, admins, and full-access shares", () => {
    const page = makePage("managed", { createdBy: "creator" });
    const pagesById = { [page.id]: page };
    const member = (userId: string, role: string) => ({
      id: `member-${userId}`,
      workspaceId: workspace.id,
      userId,
      role,
    });

    expect(canManagePage({ page, pagesById, workspace, userId: "owner" })).toBe(true);
    expect(
      canManagePage({
        page,
        pagesById,
        workspace,
        currentMember: member("creator", "member"),
        userId: "creator",
      })
    ).toBe(true);
    expect(canManagePage({ page, pagesById, workspace, userId: "creator" })).toBe(false);
    expect(
      canManagePage({
        page,
        pagesById,
        workspace,
        currentMember: member("admin", "admin"),
        userId: "admin",
      })
    ).toBe(true);
    expect(
      canManagePage({
        page,
        pagesById,
        pageRoles: { [page.id]: "full_access" },
        workspace,
        userId: "invitee",
      })
    ).toBe(true);
    expect(
      canManagePage({
        page,
        pagesById,
        pageRoles: { [page.id]: "edit" },
        workspace,
        currentMember: member("editor", "member"),
        userId: "editor",
      })
    ).toBe(false);
  });

  it("does not borrow manage authority across workspaces", () => {
    const foreign = makePage("foreign-managed", { workspaceId: "foreign" });
    expect(
      canManagePage({
        page: foreign,
        pagesById: { [foreign.id]: foreign },
        pageRoles: { [foreign.id]: "full_access" },
        workspace,
        userId: "invitee",
      })
    ).toBe(false);
  });
});
