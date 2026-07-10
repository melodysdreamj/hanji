// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchRemoteHanjiExport,
  hanjiFileSourceFingerprint,
  hanjiRemoteSourceFingerprint,
} from "@/components/nativeExport";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native import source safety", () => {
  it("changes the source fingerprint for file, endpoint, workspace, and credential changes", () => {
    const fileA = new File(["{}"], "backup.hanji.json", {
      type: "application/json",
      lastModified: 1,
    });
    const fileB = new File(["{\"changed\":true}"], "backup.hanji.json", {
      type: "application/json",
      lastModified: 2,
    });
    expect(hanjiFileSourceFingerprint(fileA)).not.toBe(hanjiFileSourceFingerprint(fileB));
    expect(hanjiRemoteSourceFingerprint("https://one.test", "ws", "token-a")).not.toBe(
      hanjiRemoteSourceFingerprint("https://one.test", "ws", "token-b")
    );
    expect(hanjiRemoteSourceFingerprint("https://one.test", "ws", "token-a")).not.toBe(
      hanjiRemoteSourceFingerprint("https://two.test", "ws", "token-a")
    );
  });

  it("aborts a remote export that exceeds its timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
      )
    );

    const request = fetchRemoteHanjiExport("https://remote.test", "ws", undefined, {
      timeoutMs: 1_000,
    });
    const expectation = expect(request).rejects.toThrow("did not respond in time");
    await vi.advanceTimersByTimeAsync(1_100);
    await expectation;
  });

  it("honors a caller AbortSignal without rewriting it as a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
        })
      )
    );
    const controller = new AbortController();
    const request = fetchRemoteHanjiExport("https://remote.test", "ws", undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
