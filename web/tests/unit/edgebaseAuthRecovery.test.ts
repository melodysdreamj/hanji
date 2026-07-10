// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({
  user: { id: "stale-user" } as { id: string } | null,
  refreshSession: vi.fn<() => Promise<{ user?: { id?: string } }>>(),
  signOut: vi.fn<() => Promise<void>>(),
  signInAnonymously: vi.fn<() => Promise<{ user?: { id?: string } }>>(),
  createClient: vi.fn(),
}));

vi.mock("@edge-base/web", () => ({
  createClient: (...args: unknown[]) => {
    authMock.createClient(...args);
    return {
      auth: {
        get currentUser() {
          return authMock.user;
        },
        refreshSession: authMock.refreshSession,
        signOut: authMock.signOut,
        signInAnonymously: authMock.signInAnonymously,
        onAuthStateChange: vi.fn(() => () => {}),
      },
    };
  },
}));

import { ensureAuth, restoreAuthSessionRemote, signOutRemote } from "@/lib/edgebase";

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("edgebase:refresh-token", "stale-but-decodable-token");
  authMock.user = { id: "stale-user" };
  authMock.refreshSession.mockReset();
  authMock.signOut.mockReset();
  authMock.signOut.mockResolvedValue();
  authMock.signInAnonymously.mockReset();
  authMock.createClient.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ allowAnonymousBootstrap: true }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  )));
});

it("validates a cached refresh-token identity before trusting it", async () => {
  authMock.refreshSession.mockImplementation(async () => {
    authMock.user = null;
    window.localStorage.removeItem("edgebase:refresh-token");
    throw Object.assign(new Error("refresh rejected"), { code: 401 });
  });
  authMock.signInAnonymously.mockImplementation(async () => {
    authMock.user = { id: "recovered-user" };
    return { user: authMock.user };
  });

  await expect(ensureAuth()).resolves.toBe("recovered-user");
  expect(authMock.refreshSession).toHaveBeenCalledOnce();
  expect(authMock.signInAnonymously).toHaveBeenCalledOnce();
  expect(authMock.user).toEqual({ id: "recovered-user" });
  expect(authMock.createClient).toHaveBeenCalledWith(
    expect.any(String),
    { refreshTokenTransport: "httpOnlyCookie" },
  );
});

it("attempts a remote cookie refresh even without JavaScript session state", async () => {
  window.localStorage.clear();
  authMock.user = null;
  authMock.refreshSession.mockImplementation(async () => {
    authMock.user = { id: "cookie-user" };
    return { user: authMock.user };
  });

  await expect(restoreAuthSessionRemote()).resolves.toBe("cookie-user");
  expect(authMock.refreshSession).toHaveBeenCalledOnce();
});

it("keeps a cached identity only for transient refresh failures", async () => {
  authMock.user = { id: "offline-user" };
  authMock.refreshSession.mockRejectedValue(
    Object.assign(new Error("network unavailable"), { code: 0 }),
  );
  await expect(restoreAuthSessionRemote()).resolves.toBe("offline-user");

  authMock.user = { id: "rejected-user" };
  authMock.refreshSession.mockRejectedValue(
    Object.assign(new Error("session revoked"), { code: 401 }),
  );
  await expect(restoreAuthSessionRemote()).resolves.toBe("");
});

it("clears product session cache before a remote sign-out can settle", async () => {
  let finishSignOut!: () => void;
  authMock.signOut.mockImplementation(() =>
    new Promise<void>((resolve) => {
      finishSignOut = resolve;
    })
  );
  window.localStorage.setItem("notionlike.workspaceId", "private-workspace");

  const pending = signOutRemote();
  expect(window.localStorage.getItem("notionlike.workspaceId")).toBeNull();

  finishSignOut();
  await expect(pending).resolves.toBeUndefined();
});
