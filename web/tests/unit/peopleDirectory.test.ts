import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actorLabel, personLabel, setWorkspacePeople } from "@/lib/peopleDirectory";

beforeEach(() => {
  setWorkspacePeople([], []);
  vi.stubGlobal("navigator", { language: "en-US" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("people directory fallbacks", () => {
  it("does not expose a stale guest UUID as a user-facing name", () => {
    expect(personLabel("9af465ae-f3aa-4cb7-9dad-6089ae8b5261")).toBe("Guest");
  });

  it("keeps authoritative member names and the current-user label", () => {
    setWorkspacePeople([
      {
        id: "member",
        workspaceId: "ws",
        userId: "known",
        displayName: "June",
        role: "member",
      },
    ]);
    expect(personLabel("known")).toBe("June");
    expect(personLabel("known", "known")).toBe("June (you)");
    expect(actorLabel(undefined, "known")).toBe("You");
  });
});
