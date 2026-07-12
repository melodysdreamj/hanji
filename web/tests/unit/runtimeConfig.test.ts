import { describe, expect, it } from "vitest";

import { DEFAULT_LEGAL_LINKS, normalizeLegalLinks, oauthProviderOptions } from "@/lib/edgebase";

describe("runtime legal-link normalization", () => {
  it("keeps one-character official OAuth provider names", () => {
    expect(oauthProviderOptions(["x", "google"]).map((entry) => entry.provider))
      .toEqual(["x", "google"]);
  });

  it("keeps public HTTPS links", () => {
    expect(normalizeLegalLinks({
      sourceUrl: "https://source.example/release",
      agplLicenseUrl: "https://source.example/release/LICENSE",
      sponsorExceptionUrl: "https://source.example/release/LICENSE-EXCEPTION",
    })).toEqual({
      sourceUrl: "https://source.example/release",
      agplLicenseUrl: "https://source.example/release/LICENSE",
      sponsorExceptionUrl: "https://source.example/release/LICENSE-EXCEPTION",
    });
  });

  it("falls back for malformed, non-HTTPS, private, and credentialed links", () => {
    expect(normalizeLegalLinks({
      sourceUrl: "javascript:alert(1)",
      agplLicenseUrl: "https://[fd00::1]/LICENSE",
      sponsorExceptionUrl: "https://user:password@example.com/LICENSE-EXCEPTION",
    })).toEqual(DEFAULT_LEGAL_LINKS);
  });
});
