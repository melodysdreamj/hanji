import { describe, expect, it } from "vitest";
import { isPublicSharePath, routeInfoFromPath } from "@/lib/router";

describe("route parsing", () => {
  it.each([
    ["/", { kind: "home" }],
    ["/trash/", { kind: "trash" }],
    ["/settings", { kind: "settings" }],
    ["/account/", { kind: "account" }],
    ["/p/page-1", { kind: "page", pageId: "page-1" }],
    ["/database/database-1/", { kind: "database", databaseId: "database-1" }],
    ["/workspace/%ED%95%9C%EC%A7%80", { kind: "workspace", workspaceSlug: "한지" }],
    ["/share/public-token", { kind: "share", shareId: "public-token" }],
  ])("recognizes %s", (pathname, expected) => {
    expect(routeInfoFromPath(pathname)).toEqual(expected);
  });

  it.each([
    ["/p/%", "page"],
    ["/p/%2Fetc", "page"],
    ["/workspace/", "workspace"],
    ["/share", "share"],
    ["/share/token/extra", "share"],
    ["/database/id%3Fquery", "database"],
  ])("turns malformed recognized paths into an explicit invalid route: %s", (pathname, routeKind) => {
    expect(() => routeInfoFromPath(pathname)).not.toThrow();
    expect(routeInfoFromPath(pathname)).toEqual({ kind: "invalid", routeKind });
  });

  it("keeps unknown paths distinct from malformed known routes", () => {
    expect(routeInfoFromPath("/does-not-exist")).toEqual({ kind: "unknown" });
  });

  it.each(["/share", "/share/", "/share/%", "/share/token/extra"])(
    "keeps malformed shared-link paths public so they show link help instead of a sign-in gate: %s",
    (pathname) => {
      expect(isPublicSharePath(pathname)).toBe(true);
    },
  );

  it("does not classify a similarly prefixed path as a public share", () => {
    expect(isPublicSharePath("/shared-notes")).toBe(false);
  });
});
