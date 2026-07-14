// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openPdfInNewTab } from "@/lib/pdfPreview";

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
  if (originalCreateObjectUrl) Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
  else delete (URL as { createObjectURL?: unknown }).createObjectURL;
  if (originalRevokeObjectUrl) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
  else delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
});

function previewWindow() {
  return {
    closed: false,
    close: vi.fn(),
    document: { title: "" },
    location: { replace: vi.fn() },
    opener: window,
  };
}

describe("openPdfInNewTab", () => {
  it("opens verified PDF bytes as an application/pdf Blob in the reserved tab", async () => {
    vi.useFakeTimers();
    const preview = previewWindow();
    vi.spyOn(window, "open").mockReturnValue(preview as unknown as Window);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode("prefix\n%PDF-1.4\n%%EOF").buffer,
    })));
    const createObjectURL = vi.fn(() => "blob:https://hanji.example/pdf-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    await expect(openPdfInNewTab(() => "https://hanji.example/signed-pdf", "manual.pdf")).resolves.toBe(true);

    expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(preview.opener).toBeNull();
    expect(preview.document.title).toBe("manual.pdf");
    expect(fetch).toHaveBeenCalledWith("https://hanji.example/signed-pdf", { credentials: "include" });
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe("application/pdf");
    expect(preview.location.replace).toHaveBeenCalledWith("blob:https://hanji.example/pdf-preview");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:https://hanji.example/pdf-preview");
  });

  it("falls back to the original new-tab URL when external bytes cannot be fetched", async () => {
    const preview = previewWindow();
    vi.spyOn(window, "open").mockReturnValue(preview as unknown as Window);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("CORS blocked"); }));

    await expect(openPdfInNewTab(() => "https://files.example/manual.pdf", "manual.pdf")).resolves.toBe(true);
    expect(preview.location.replace).toHaveBeenCalledWith("https://files.example/manual.pdf");
    expect(preview.close).not.toHaveBeenCalled();
  });
});
