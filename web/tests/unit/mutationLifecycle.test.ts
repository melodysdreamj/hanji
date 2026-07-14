import { describe, expect, it, vi } from "vitest";

import { runAcknowledgedMutation } from "@/lib/mutationLifecycle";

describe("acknowledged mutation lifecycle", () => {
  it("commits authoritative local state before acknowledging the outbox", async () => {
    const events: string[] = [];
    const result = await runAcknowledgedMutation({
      send: async () => {
        events.push("send");
        return { id: "row-1" };
      },
      commit: async (accepted) => {
        events.push(`commit:${accepted.id}`);
      },
      acknowledge: () => {
        events.push("ack");
      },
      onPhase: (phase) => events.push(`phase:${phase}`),
    });

    expect(result).toEqual({ id: "row-1" });
    expect(events).toEqual([
      "phase:remote_sending",
      "send",
      "phase:remote_accepted",
      "phase:local_committing",
      "commit:row-1",
      "phase:local_committed",
      "phase:outbox_acknowledging",
      "ack",
      "phase:completed",
    ]);
  });

  it("does not commit or acknowledge when the remote send fails", async () => {
    const commit = vi.fn();
    const acknowledge = vi.fn();

    await expect(
      runAcknowledgedMutation({
        send: async () => {
          throw new Error("offline");
        },
        commit,
        acknowledge,
      })
    ).rejects.toThrow("offline");

    expect(commit).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("retains the outbox entry when authoritative local commit fails", async () => {
    const acknowledge = vi.fn();

    await expect(
      runAcknowledgedMutation({
        send: async () => ({ id: "block-1" }),
        commit: async () => {
          throw new Error("cache unavailable");
        },
        acknowledge,
      })
    ).rejects.toThrow("cache unavailable");

    expect(acknowledge).not.toHaveBeenCalled();
  });
});
