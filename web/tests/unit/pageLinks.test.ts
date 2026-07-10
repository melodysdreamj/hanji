import { describe, expect, it } from "vitest";
import { decodePathPart, pageIdFromPageHref, remapPageHref } from "@/lib/pageLinks";

describe("decodePathPart", () => {
  it("decodes percent-encoded parts", () => {
    expect(decodePathPart("abc%20def")).toBe("abc def");
    expect(decodePathPart("%ED%8E%98%EC%9D%B4%EC%A7%80")).toBe("페이지");
  });

  it("returns the raw value when decoding fails", () => {
    expect(decodePathPart("%E0%A4%A")).toBe("%E0%A4%A");
  });
});

describe("pageIdFromPageHref", () => {
  it("extracts the id from relative /p/ links", () => {
    expect(pageIdFromPageHref("/p/abc123")).toBe("abc123");
    expect(pageIdFromPageHref("/p/abc123/sub")).toBe("abc123");
    expect(pageIdFromPageHref("/p/abc123?x=1#frag")).toBe("abc123");
  });

  it("extracts the id from absolute URLs", () => {
    expect(pageIdFromPageHref("https://example.com/p/abc123?x=1")).toBe("abc123");
  });

  it("extracts the id from the notionlike:// scheme", () => {
    expect(pageIdFromPageHref("notionlike://page/abc123")).toBe("abc123");
    expect(pageIdFromPageHref("NOTIONLIKE://PAGE/abc123?x#y")).toBe("abc123");
  });

  it("decodes percent-encoded ids", () => {
    expect(pageIdFromPageHref("/p/a%20b")).toBe("a b");
    expect(pageIdFromPageHref("notionlike://page/a%2Fb")).toBe("a/b");
  });

  it("returns null for non-page links and empty input", () => {
    expect(pageIdFromPageHref(undefined)).toBeNull();
    expect(pageIdFromPageHref("")).toBeNull();
    expect(pageIdFromPageHref("   ")).toBeNull();
    expect(pageIdFromPageHref("https://example.com/other")).toBeNull();
    expect(pageIdFromPageHref("/pp/abc")).toBeNull();
    expect(pageIdFromPageHref("mailto:x@example.com")).toBeNull();
  });
});

describe("remapPageHref", () => {
  const map = new Map([
    ["old", "new"],
    ["한글", "korean-id"],
  ]);

  it("returns the href untouched without a map or with an empty map", () => {
    expect(remapPageHref("/p/old")).toBe("/p/old");
    expect(remapPageHref("/p/old", new Map())).toBe("/p/old");
    expect(remapPageHref(undefined, map)).toBeUndefined();
  });

  it("remaps relative /p/ links preserving query and hash", () => {
    expect(remapPageHref("/p/old", map)).toBe("/p/new");
    expect(remapPageHref("/p/old?x=1#frag", map)).toBe("/p/new?x=1#frag");
  });

  it("remaps absolute URLs", () => {
    expect(remapPageHref("https://example.com/p/old?x=1", map)).toBe(
      "https://example.com/p/new?x=1"
    );
  });

  it("remaps notionlike://page links", () => {
    expect(remapPageHref("notionlike://page/old", map)).toBe(
      "notionlike://page/new"
    );
  });

  it("encodes remapped ids", () => {
    const encMap = new Map([["old", "a b/c"]]);
    expect(remapPageHref("/p/old", encMap)).toBe("/p/a%20b%2Fc");
  });

  it("remaps percent-encoded source ids", () => {
    expect(remapPageHref("notionlike://page/%ED%95%9C%EA%B8%80", map)).toBe(
      "notionlike://page/korean-id"
    );
  });

  it("leaves unknown ids and non-page links untouched", () => {
    expect(remapPageHref("/p/unknown", map)).toBe("/p/unknown");
    expect(remapPageHref("https://example.com/other", map)).toBe(
      "https://example.com/other"
    );
  });
});
