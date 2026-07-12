// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const legalMock = vi.hoisted(() => ({
  runtimeConfig: vi.fn(),
  defaults: {
    sourceUrl: "https://github.com/melodysdreamj/hanji",
    agplLicenseUrl: "https://github.com/melodysdreamj/hanji/blob/main/LICENSE",
    sponsorExceptionUrl: "https://github.com/melodysdreamj/hanji/blob/main/LICENSE-EXCEPTION",
  },
}));

vi.mock("@/lib/edgebase", () => ({
  DEFAULT_LEGAL_LINKS: legalMock.defaults,
  fetchRuntimeConfigRemote: legalMock.runtimeConfig,
}));

import { LegalNotice } from "@/components/LegalNotice";

beforeEach(() => {
  legalMock.runtimeConfig.mockReset();
  legalMock.runtimeConfig.mockResolvedValue({
    allowAnonymousBootstrap: false,
    legal: legalMock.defaults,
  });
});

afterEach(cleanup);

describe("LegalNotice", () => {
  it("renders distinct source, AGPL, and sponsor-exception links", async () => {
    legalMock.runtimeConfig.mockResolvedValue({
      allowAnonymousBootstrap: false,
      legal: {
        sourceUrl: "https://source.example/releases/v1",
        agplLicenseUrl: "https://source.example/releases/v1/LICENSE",
        sponsorExceptionUrl: "https://source.example/releases/v1/LICENSE-EXCEPTION",
      },
    });

    render(<LegalNotice />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Source" }).getAttribute("href"))
        .toBe("https://source.example/releases/v1");
    });
    expect(screen.getByRole("link", { name: "AGPL-3.0" }).getAttribute("href"))
      .toBe("https://source.example/releases/v1/LICENSE");
    expect(screen.getByRole("link", { name: "Exception 2.0" }).getAttribute("href"))
      .toBe("https://source.example/releases/v1/LICENSE-EXCEPTION");
  });

  it("shows safe upstream links before runtime configuration settles", () => {
    legalMock.runtimeConfig.mockReturnValue(new Promise(() => undefined));
    render(<LegalNotice />);

    expect(screen.getByRole("link", { name: "Source" }).getAttribute("href"))
      .toBe(legalMock.defaults.sourceUrl);
    expect(screen.getByRole("link", { name: "AGPL-3.0" }).getAttribute("href"))
      .toBe(legalMock.defaults.agplLicenseUrl);
    expect(screen.getByRole("link", { name: "Exception 2.0" }).getAttribute("href"))
      .toBe(legalMock.defaults.sponsorExceptionUrl);
  });
});
