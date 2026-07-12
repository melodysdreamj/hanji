// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { TextSpan } from "@/lib/types";
import {
  coalesce,
  concatSpans,
  escapeHtml,
  htmlToSpans,
  safeColorToken,
  safeCommentId,
  safeDateMentionValue,
  safeMentionId,
  safeUrl,
  spansPlainText,
  spansToHtml,
  splitSpans,
} from "@/components/editor/richtext";

describe("escapeHtml", () => {
  it("escapes html special characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
    );
  });

  it("passes plain and unicode text through", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("한글 텍스트")).toBe("한글 텍스트");
  });
});

describe("safeUrl", () => {
  it("allows http/https/mailto/relative/anchor urls", () => {
    expect(safeUrl("https://example.com")).toBe("https://example.com");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:user@example.com")).toBe("mailto:user@example.com");
    expect(safeUrl("/p/abc")).toBe("/p/abc");
    expect(safeUrl("#anchor")).toBe("#anchor");
    expect(safeUrl("  https://trim.example/path  ")).toBe("https://trim.example/path");
  });

  it("blocks javascript:, data:, vbscript: and other schemes", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<script>")).toBe("");
    expect(safeUrl("vbscript:msgbox")).toBe("");
    expect(safeUrl("ftp://example.com")).toBe("");
    expect(safeUrl(undefined)).toBe("");
    expect(safeUrl("")).toBe("");
  });
});

describe("safeColorToken", () => {
  it("accepts known tokens", () => {
    expect(safeColorToken("red")).toBe("red");
    expect(safeColorToken("blue_background")).toBe("blue_background");
  });

  it("rejects unknown tokens", () => {
    expect(safeColorToken("magenta")).toBeUndefined();
    expect(safeColorToken("")).toBeUndefined();
    expect(safeColorToken(undefined)).toBeUndefined();
  });
});

describe("safeCommentId / safeMentionId", () => {
  it("accepts simple ids", () => {
    expect(safeCommentId("abc-123_X")).toBe("abc-123_X");
    expect(safeMentionId("user@example.com")).toBe("user@example.com");
    expect(safeMentionId("  trimmed  ")).toBe("trimmed");
  });

  it("rejects unsafe or empty ids", () => {
    expect(safeCommentId('x" onload="')).toBeUndefined();
    expect(safeCommentId("")).toBeUndefined();
    expect(safeMentionId("<script>")).toBeUndefined();
    expect(safeMentionId("a".repeat(201))).toBeUndefined();
    expect(safeMentionId(undefined)).toBeUndefined();
  });
});

describe("safeDateMentionValue", () => {
  it("accepts plain dates and datetimes", () => {
    expect(safeDateMentionValue("2026-07-04")).toBe("2026-07-04");
    expect(safeDateMentionValue("2026-07-04T09:30")).toBe("2026-07-04T09:30");
    expect(safeDateMentionValue("2026-07-04 09:30:15.250Z")).toBe(
      "2026-07-04 09:30:15.250Z"
    );
    expect(safeDateMentionValue("2026-07-04T09:30:15+09:00")).toBe(
      "2026-07-04T09:30:15+09:00"
    );
  });

  it("rejects invalid calendar dates and times", () => {
    expect(safeDateMentionValue("2026-02-30")).toBeUndefined();
    expect(safeDateMentionValue("2026-13-01")).toBeUndefined();
    expect(safeDateMentionValue("2026-07-04T24:00")).toBeUndefined();
    expect(safeDateMentionValue("2026-07-04T09:61")).toBeUndefined();
    expect(safeDateMentionValue("2026-07-04T09:30+25:00")).toBeUndefined();
    expect(safeDateMentionValue("not-a-date")).toBeUndefined();
    expect(safeDateMentionValue("")).toBeUndefined();
    expect(safeDateMentionValue(undefined)).toBeUndefined();
  });

  it("accepts leap-day dates", () => {
    expect(safeDateMentionValue("2028-02-29")).toBe("2028-02-29");
    expect(safeDateMentionValue("2027-02-29")).toBeUndefined();
  });
});

describe("spansToHtml", () => {
  it("returns empty string for empty input", () => {
    expect(spansToHtml()).toBe("");
    expect(spansToHtml([])).toBe("");
  });

  it("renders marks nested in a fixed order", () => {
    expect(
      spansToHtml([{ text: "x", bold: true, italic: true, code: true }])
    ).toBe("<em><strong><code>x</code></strong></em>");
    expect(spansToHtml([{ text: "s", strikethrough: true, underline: true }])).toBe(
      "<s><u>s</u></s>"
    );
  });

  it("escapes text content", () => {
    expect(spansToHtml([{ text: "<b>&" }])).toBe("&lt;b&gt;&amp;");
  });

  it("renders safe links and drops unsafe ones", () => {
    expect(spansToHtml([{ text: "x", link: "https://a.io" }])).toBe(
      '<a href="https://a.io">x</a>'
    );
    expect(spansToHtml([{ text: "x", link: "javascript:alert(1)" }])).toBe("x");
  });

  it("renders color and comment wrappers", () => {
    expect(spansToHtml([{ text: "x", color: "red" }])).toBe(
      '<span data-color="red">x</span>'
    );
    expect(spansToHtml([{ text: "x", commentId: "c1" }])).toBe(
      '<span data-comment-id="c1">x</span>'
    );
    expect(spansToHtml([{ text: "x", color: "not-a-color" }])).toBe("x");
  });

  it("renders page mentions as non-editable anchors", () => {
    expect(spansToHtml([{ text: "@Page", mention: "page", pageId: "p1" }])).toBe(
      '<a href="/p/p1" data-mention="page" data-page-id="p1" contenteditable="false">@Page</a>'
    );
  });

  it("renders person mentions", () => {
    expect(spansToHtml([{ text: "@Ari", mention: "person", userId: "u1" }])).toBe(
      '<span data-mention="person" data-user-id="u1" contenteditable="false">@Ari</span>'
    );
  });

  it("renders date mentions with display text derived from the value", () => {
    const html = spansToHtml([
      { text: "@2001-06-01", mention: "date", date: "2001-06-01" },
    ]);
    expect(html).toContain('data-mention="date"');
    expect(html).toContain('data-date="2001-06-01"');
    // Historical dates render with a Korean locale label including the year.
    expect(html).toContain("2001");
  });

  it("drops the mention wrapper when the mention id is unsafe", () => {
    expect(spansToHtml([{ text: "x", mention: "page", pageId: "<bad>" }])).toBe("x");
  });
});

describe("spansPlainText", () => {
  it("joins span texts", () => {
    expect(spansPlainText([{ text: "a" }, { text: "b", bold: true }])).toBe("ab");
    expect(spansPlainText()).toBe("");
  });
});

describe("coalesce", () => {
  it("merges adjacent spans with identical marks", () => {
    expect(
      coalesce([
        { text: "a", bold: true },
        { text: "b", bold: true },
        { text: "c" },
      ])
    ).toEqual([{ text: "ab", bold: true }, { text: "c" }]);
  });

  it("drops empty spans", () => {
    expect(coalesce([{ text: "" }, { text: "a" }, { text: "" }])).toEqual([
      { text: "a" },
    ]);
  });

  it("does not merge spans with different marks", () => {
    expect(coalesce([{ text: "a", link: "/x" }, { text: "b", link: "/y" }])).toHaveLength(2);
  });

  it("does not mutate its input", () => {
    const input: TextSpan[] = [{ text: "a" }, { text: "b" }];
    coalesce(input);
    expect(input).toEqual([{ text: "a" }, { text: "b" }]);
  });
});

describe("splitSpans", () => {
  const spans: TextSpan[] = [{ text: "abc", bold: true }, { text: "def" }];

  it("splits at a span boundary", () => {
    expect(splitSpans(spans, 3)).toEqual([
      [{ text: "abc", bold: true }],
      [{ text: "def" }],
    ]);
  });

  it("splits inside a span", () => {
    expect(splitSpans(spans, 4)).toEqual([
      [{ text: "abc", bold: true }, { text: "d" }],
      [{ text: "ef" }],
    ]);
  });

  it("handles offsets at the ends", () => {
    expect(splitSpans(spans, 0)).toEqual([[], [{ text: "abc", bold: true }, { text: "def" }]]);
    expect(splitSpans(spans, 6)[1]).toEqual([]);
    expect(splitSpans([], 3)).toEqual([[], []]);
  });
});

describe("concatSpans", () => {
  it("joins and coalesces", () => {
    expect(concatSpans([{ text: "a" }], [{ text: "b" }])).toEqual([{ text: "ab" }]);
    expect(concatSpans([], [])).toEqual([]);
  });
});

describe("htmlToSpans", () => {
  const parse = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return htmlToSpans(root);
  };

  it("reads plain text", () => {
    expect(parse("hello")).toEqual([{ text: "hello" }]);
  });

  it("reads nested formatting tags", () => {
    expect(parse("<strong><em>x</em></strong>")).toEqual([
      { text: "x", bold: true, italic: true },
    ]);
    expect(parse("<b>b</b><i>i</i><u>u</u><s>s</s><code>c</code>")).toEqual([
      { text: "b", bold: true },
      { text: "i", italic: true },
      { text: "u", underline: true },
      { text: "s", strikethrough: true },
      { text: "c", code: true },
    ]);
  });

  it("converts <br> and block elements to newlines", () => {
    expect(parse("a<br>b")).toEqual([{ text: "a\nb" }]);
    expect(parse("<div>a</div><div>b</div>")).toEqual([{ text: "a\nb" }]);
  });

  it("strips zero-width spaces", () => {
    expect(parse("a​b")).toEqual([{ text: "ab" }]);
  });

  it("reads safe links and ignores unsafe hrefs", () => {
    expect(parse('<a href="https://a.io">x</a>')).toEqual([
      { text: "x", link: "https://a.io" },
    ]);
    expect(parse('<a href="javascript:alert(1)">x</a>')).toEqual([{ text: "x" }]);
  });

  it("reads data-color tokens and inline style colors", () => {
    expect(parse('<span data-color="red">x</span>')).toEqual([
      { text: "x", color: "red" },
    ]);
    expect(parse('<span style="color: rgb(212, 76, 71)">x</span>')).toEqual([
      { text: "x", color: "red" },
    ]);
    expect(
      parse('<span style="background-color: rgb(251, 243, 219)">x</span>')
    ).toEqual([{ text: "x", color: "yellow_background" }]);
  });

  it("reads mention elements", () => {
    expect(
      parse('<a data-mention="page" data-page-id="p1" href="/p/p1">@Page</a>')
    ).toEqual([{ text: "@Page", mention: "page", pageId: "p1" }]);
    expect(
      parse('<span data-mention="date" data-date="2026-07-04">@today</span>')
    ).toEqual([{ text: "@today", mention: "date", date: "2026-07-04" }]);
    expect(
      parse('<span data-mention="person" data-user-id="u1">@Ari</span>')
    ).toEqual([{ text: "@Ari", mention: "person", userId: "u1" }]);
  });

  it("ignores mention markers with invalid payloads", () => {
    expect(
      parse('<span data-mention="date" data-date="not-a-date">@x</span>')
    ).toEqual([{ text: "@x" }]);
  });

  it("round-trips spansToHtml output", () => {
    const spans: TextSpan[] = [
      { text: "plain " },
      { text: "bold", bold: true },
      { text: " and ", color: "red" },
      { text: "링크", link: "https://a.io" },
    ];
    expect(parse(spansToHtml(spans))).toEqual(spans);
  });
});
