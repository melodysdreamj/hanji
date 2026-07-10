// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  parseInlineMarkdown,
  parseInternalPastedBlocks,
  parseMarkdownTableRows,
  parsePastedHtml,
  parsePastedMarkdown,
  type PastedBlock,
} from "@/components/editor/markdownPaste";
import { NOTIONLIKE_BLOCKS_MIME } from "@/lib/clipboard";

const text = (block: PastedBlock | undefined) =>
  (block?.content?.rich ?? []).map((span) => span.text).join("");

describe("parseInlineMarkdown", () => {
  it("returns [] for empty input", () => {
    expect(parseInlineMarkdown("")).toEqual([]);
  });

  it("parses plain text as a single span", () => {
    expect(parseInlineMarkdown("hello world")).toEqual([{ text: "hello world" }]);
  });

  it("parses bold, italic, and strikethrough", () => {
    expect(parseInlineMarkdown("**bold**")).toEqual([{ text: "bold", bold: true }]);
    expect(parseInlineMarkdown("__bold__")).toEqual([{ text: "bold", bold: true }]);
    expect(parseInlineMarkdown("*it*")).toEqual([{ text: "it", italic: true }]);
    expect(parseInlineMarkdown("_it_")).toEqual([{ text: "it", italic: true }]);
    expect(parseInlineMarkdown("~~gone~~")).toEqual([
      { text: "gone", strikethrough: true },
    ]);
  });

  it("nests marks (bold containing italic)", () => {
    expect(parseInlineMarkdown("**a *b* c**")).toEqual([
      { text: "a ", bold: true },
      { text: "b", bold: true, italic: true },
      { text: " c", bold: true },
    ]);
  });

  it("parses inline code and suppresses nested marks inside it", () => {
    expect(parseInlineMarkdown("`**not bold**`")).toEqual([
      { text: "**not bold**", code: true },
    ]);
  });

  it("supports multi-backtick code fences containing backticks", () => {
    // Padding spaces are only stripped when they shield an edge backtick.
    expect(parseInlineMarkdown("`` `edge ``")).toEqual([{ text: "`edge", code: true }]);
    expect(parseInlineMarkdown("`` a`b ``")).toEqual([{ text: " a`b ", code: true }]);
  });

  it("leaves unmatched markers literal", () => {
    expect(parseInlineMarkdown("**unclosed")).toEqual([{ text: "**unclosed" }]);
    expect(parseInlineMarkdown("a * b")).toEqual([{ text: "a * b" }]);
    expect(parseInlineMarkdown("`open")).toEqual([{ text: "`open" }]);
  });

  it("honors backslash escapes", () => {
    expect(parseInlineMarkdown("\\*literal\\*")).toEqual([{ text: "*literal*" }]);
    expect(parseInlineMarkdown("\\`x\\`")).toEqual([{ text: "`x`" }]);
  });

  it("parses [label](url) links", () => {
    expect(parseInlineMarkdown("[site](https://a.io)")).toEqual([
      { text: "site", link: "https://a.io" },
    ]);
  });

  it("normalizes bare-domain link targets", () => {
    expect(parseInlineMarkdown("[site](example.com/x)")).toEqual([
      { text: "site", link: "https://example.com/x" },
    ]);
  });

  it("keeps unsafe link targets as plain text", () => {
    expect(parseInlineMarkdown("[x](javascript:alert(1))")).toEqual([
      { text: "[x](javascript:alert(1))" },
    ]);
  });

  it("parses page/date/person mention hrefs", () => {
    expect(parseInlineMarkdown("[Page](/p/p1)")).toEqual([
      { text: "Page", mention: "page", pageId: "p1" },
    ]);
    expect(parseInlineMarkdown("[@today](notionlike://date/2026-07-04)")).toEqual([
      { text: "@today", mention: "date", date: "2026-07-04" },
    ]);
    expect(parseInlineMarkdown("[@June](notionlike://person/u1)")).toEqual([
      { text: "@June", mention: "person", userId: "u1" },
    ]);
  });

  it("auto-links bare urls and domains", () => {
    expect(parseInlineMarkdown("see https://a.io/x now")).toEqual([
      { text: "see " },
      { text: "https://a.io/x", link: "https://a.io/x" },
      { text: " now" },
    ]);
    expect(parseInlineMarkdown("example.com rocks")).toEqual([
      { text: "example.com", link: "https://example.com" },
      { text: " rocks" },
    ]);
    expect(parseInlineMarkdown("localhost:3000/x")).toEqual([
      { text: "localhost:3000/x", link: "https://localhost:3000/x" },
    ]);
  });

  it("strips trailing punctuation from auto-links", () => {
    expect(parseInlineMarkdown("go to https://a.io.")).toEqual([
      { text: "go to " },
      { text: "https://a.io", link: "https://a.io" },
      { text: "." },
    ]);
  });

  it("does not auto-link mid-word domains", () => {
    expect(parseInlineMarkdown("user@example.com")).toEqual([
      { text: "user@example.com" },
    ]);
  });

  it("handles Korean text with marks", () => {
    expect(parseInlineMarkdown("**굵게** 일반")).toEqual([
      { text: "굵게", bold: true },
      { text: " 일반" },
    ]);
  });
});

describe("parseMarkdownTableRows", () => {
  it("parses a simple header + separator + body table", () => {
    expect(
      parseMarkdownTableRows("| A | B |\n| --- | --- |\n| 1 | 2 |")
    ).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("returns null when the separator row is missing", () => {
    expect(parseMarkdownTableRows("| A | B |\n| 1 | 2 |")).toBeNull();
    expect(parseMarkdownTableRows("plain text")).toBeNull();
    expect(parseMarkdownTableRows("")).toBeNull();
  });

  it("supports alignment colons in the separator", () => {
    expect(
      parseMarkdownTableRows("| A | B |\n| :--- | ---: |\n| 1 | 2 |")
    ).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });

  it("pads ragged rows to the widest column count", () => {
    expect(
      parseMarkdownTableRows("| A | B | C |\n| --- | --- | --- |\n| 1 | 2 |")
    ).toEqual([
      ["A", "B", "C"],
      ["1", "2", ""],
    ]);
  });

  it("stops collecting body rows at a single-cell line (not a table row)", () => {
    expect(
      parseMarkdownTableRows("| A | B |\n| --- | --- |\n| 1 |")
    ).toEqual([["A", "B"]]);
  });

  it("unescapes \\| inside cells and converts <br> to newlines", () => {
    expect(
      parseMarkdownTableRows("| a\\|b | c<br>d |\n| --- | --- |")
    ).toEqual([["a|b", "c\nd"]]);
  });

  it("handles CRLF input", () => {
    expect(parseMarkdownTableRows("| A | B |\r\n| --- | --- |\r\n| 1 | 2 |")).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
  });
});

describe("parsePastedMarkdown", () => {
  it("parses headings 1-4 (and treats deeper hashes as paragraphs)", () => {
    const blocks = parsePastedMarkdown("# H1\n## H2\n### H3\n#### H4\n##### H5");
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "heading_2",
      "heading_3",
      "heading_4",
      "paragraph",
    ]);
    expect(text(blocks[0])).toBe("H1");
  });

  it("parses list items and to-dos", () => {
    const blocks = parsePastedMarkdown(
      "- bullet\n* star bullet\n1. numbered\n- [ ] open\n- [x] done"
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "bulleted_list_item",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "to_do",
    ]);
    expect(blocks[3].content?.checked).toBe(false);
    expect(blocks[4].content?.checked).toBe(true);
  });

  it("nests indented lines under their parent", () => {
    const blocks = parsePastedMarkdown("- parent\n  - child\n    - grandchild\n- sibling");
    expect(blocks).toHaveLength(2);
    expect(text(blocks[0])).toBe("parent");
    expect(text(blocks[0].children?.[0])).toBe("child");
    expect(text(blocks[0].children?.[0].children?.[0])).toBe("grandchild");
    expect(text(blocks[1])).toBe("sibling");
  });

  it("treats tabs as two spaces of indent", () => {
    const blocks = parsePastedMarkdown("- parent\n\t- child");
    expect(blocks).toHaveLength(1);
    expect(text(blocks[0].children?.[0])).toBe("child");
  });

  it("parses fenced code blocks with language", () => {
    const blocks = parsePastedMarkdown("```ts\nconst a = 1;\nconst b = 2;\n```");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(blocks[0].content?.language).toBe("ts");
    expect(text(blocks[0])).toBe("const a = 1;\nconst b = 2;");
  });

  it("keeps markdown syntax literal inside code fences", () => {
    const blocks = parsePastedMarkdown("```\n# not a heading\n- not a list\n```");
    expect(blocks).toHaveLength(1);
    expect(text(blocks[0])).toBe("# not a heading\n- not a list");
  });

  it("handles an unterminated code fence by consuming the rest", () => {
    const blocks = parsePastedMarkdown("```\ncode line");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("code");
    expect(text(blocks[0])).toBe("code line");
  });

  it("parses quotes, callouts, dividers, and toggles", () => {
    const blocks = parsePastedMarkdown(
      "> quoted\n> 💡 with icon\n---\n▶ toggled\n▶ ## toggle heading"
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "quote",
      "callout",
      "divider",
      "toggle",
      "toggle_heading_2",
    ]);
    expect(blocks[1].content?.icon).toBe("💡");
    expect(text(blocks[1])).toBe("with icon");
  });

  it("parses markdown tables into simple_table blocks", () => {
    const blocks = parsePastedMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\nafter");
    expect(blocks[0].type).toBe("simple_table");
    expect(blocks[0].content?.table).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(blocks[0].content?.headerRow).toBe(true);
    expect(blocks[1].type).toBe("paragraph");
  });

  it("parses equations (block and inline forms)", () => {
    const blocks = parsePastedMarkdown("$$\nx^2 + y^2\n$$\n$$e = mc^2$$");
    expect(blocks.map((b) => b.type)).toEqual(["equation", "equation"]);
    expect(blocks[0].content?.expression).toBe("x^2 + y^2");
    expect(blocks[1].content?.expression).toBe("e = mc^2");
  });

  it("parses media and bookmark link lines", () => {
    const blocks = parsePastedMarkdown(
      [
        "![cap](https://a.io/x.png)",
        "[Video](https://a.io/v.mp4)",
        "[Audio](https://a.io/a.mp3)",
        "[Embed](https://a.io/e)",
        "[File: notes.txt](https://a.io/notes.txt)",
        "[https://a.io](https://a.io)",
      ].join("\n")
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "image",
      "video",
      "audio",
      "embed",
      "file",
      "bookmark",
    ]);
    expect(blocks[0].content?.url).toBe("https://a.io/x.png");
    expect(blocks[4].content?.fileName).toBe("notes.txt");
    expect(blocks[5].content?.url).toBe("https://a.io");
  });

  it("keeps a labeled link line as a paragraph (not a bookmark)", () => {
    const blocks = parsePastedMarkdown("[label](https://a.io)");
    expect(blocks[0].type).toBe("paragraph");
  });

  it("drops image lines with unsafe urls to paragraphs", () => {
    const blocks = parsePastedMarkdown("![x](javascript:alert(1))");
    expect(blocks[0].type).toBe("paragraph");
  });

  it("parses bracket commands", () => {
    const blocks = parsePastedMarkdown(
      "[Table of contents]\n[Breadcrumb]\n[Synced block]\n[Tabs]\n[Button: Run]"
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "table_of_contents",
      "breadcrumb",
      "synced_block",
      "tab",
      "button",
    ]);
    expect(blocks[4].content?.buttonLabel).toBe("Run");
  });

  it("parses wiki page links with and without hrefs", () => {
    const blocks = parsePastedMarkdown("[[My Page]](/p/p1)\n[[Loose]]");
    expect(blocks[0].type).toBe("link_to_page");
    expect(blocks[0].content?.childPageId).toBe("p1");
    expect(blocks[1].type).toBe("link_to_page");
    expect(blocks[1].content?.childPageId).toBeUndefined();
  });

  it("skips blank lines and returns [] for empty input", () => {
    expect(parsePastedMarkdown("")).toEqual([]);
    expect(parsePastedMarkdown("\n\n  \n")).toEqual([]);
    expect(parsePastedMarkdown("a\n\n\nb")).toHaveLength(2);
  });

  it("handles CRLF line endings", () => {
    const blocks = parsePastedMarkdown("# Title\r\n- item");
    expect(blocks.map((b) => b.type)).toEqual(["heading_1", "bulleted_list_item"]);
  });

  it("parses Korean content", () => {
    const blocks = parsePastedMarkdown("# 제목\n- 항목 하나");
    expect(text(blocks[0])).toBe("제목");
    expect(text(blocks[1])).toBe("항목 하나");
  });
});

describe("parsePastedHtml", () => {
  it("returns [] for empty html", () => {
    expect(parsePastedHtml("")).toEqual([]);
    expect(parsePastedHtml("   ")).toEqual([]);
  });

  it("parses headings and paragraphs", () => {
    const blocks = parsePastedHtml("<h1>Big</h1><h2>Mid</h2><p>Body</p>");
    expect(blocks.map((b) => b.type)).toEqual(["heading_1", "heading_2", "paragraph"]);
    expect(blocks[2].plainText).toBe("Body");
  });

  it("maps h4-h6 to heading_4", () => {
    const blocks = parsePastedHtml("<h4>a</h4><h5>b</h5><h6>c</h6>");
    expect(blocks.map((b) => b.type)).toEqual(["heading_4", "heading_4", "heading_4"]);
  });

  it("parses nested lists with checkboxes", () => {
    const blocks = parsePastedHtml(
      '<ul><li>one<ul><li>nested</li></ul></li><li><input type="checkbox" checked>done</li></ul>'
    );
    expect(blocks[0].type).toBe("bulleted_list_item");
    expect(blocks[0].children?.[0].type).toBe("bulleted_list_item");
    expect(blocks[0].children?.[0].plainText).toBe("nested");
    expect(blocks[1].type).toBe("to_do");
    expect(blocks[1].content?.checked).toBe(true);
  });

  it("parses ordered lists", () => {
    const blocks = parsePastedHtml("<ol><li>first</li></ol>");
    expect(blocks[0].type).toBe("numbered_list_item");
  });

  it("parses details/summary into toggles", () => {
    const blocks = parsePastedHtml(
      "<details open><summary>Show</summary><p>Hidden</p></details>"
    );
    expect(blocks[0].type).toBe("toggle");
    expect(blocks[0].content?.collapsed).toBe(false);
    expect(blocks[0].plainText).toBe("Show");
    expect(blocks[0].children?.[0].plainText).toBe("Hidden");
  });

  it("parses tables, hr, pre, images, and blockquotes", () => {
    const blocks = parsePastedHtml(
      [
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
        "<hr>",
        '<pre><code class="language-js">let x;</code></pre>',
        '<img src="https://a.io/x.png" alt="cap">',
        "<blockquote>wise words</blockquote>",
      ].join("")
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "simple_table",
      "divider",
      "code",
      "image",
      "quote",
    ]);
    expect(blocks[0].content?.table).toEqual([
      ["A", "B"],
      ["1", "2"],
    ]);
    expect(blocks[2].content?.language).toBe("javascript");
    expect(blocks[2].plainText).toBe("let x;");
    expect(blocks[3].content?.url).toBe("https://a.io/x.png");
  });

  it("keeps inline marks from formatted html", () => {
    const blocks = parsePastedHtml("<p>plain <strong>bold</strong></p>");
    expect(blocks[0].content?.rich).toEqual([
      { text: "plain " },
      { text: "bold", bold: true },
    ]);
  });

  it("converts /p/ links into page mentions", () => {
    const blocks = parsePastedHtml('<p><a href="/p/p1">Page</a></p>');
    expect(blocks[0].content?.rich).toEqual([
      { text: "Page", mention: "page", pageId: "p1" },
    ]);
  });

  it("unwraps container divs and drops empty paragraphs", () => {
    const blocks = parsePastedHtml("<div><p>a</p><p></p><p>b</p></div>");
    expect(blocks.map((b) => b.plainText)).toEqual(["a", "b"]);
  });

  it("drops images with unsafe srcs", () => {
    expect(parsePastedHtml('<img src="javascript:alert(1)">')).toEqual([]);
  });
});

describe("parseInternalPastedBlocks", () => {
  const dataTransfer = (raw: string) =>
    ({ getData: (type: string) => (type === NOTIONLIKE_BLOCKS_MIME ? raw : "") }) as DataTransfer;

  it("returns [] for missing or malformed payloads", () => {
    expect(parseInternalPastedBlocks(dataTransfer(""))).toEqual([]);
    expect(parseInternalPastedBlocks(dataTransfer("not json"))).toEqual([]);
    expect(parseInternalPastedBlocks(dataTransfer("{}"))).toEqual([]);
    expect(
      parseInternalPastedBlocks(dataTransfer(JSON.stringify({ version: 2, blocks: [] })))
    ).toEqual([]);
  });

  it("normalizes valid blocks and drops unknown types", () => {
    const payload = JSON.stringify({
      version: 1,
      blocks: [
        {
          type: "paragraph",
          content: { rich: [{ text: "hi" }] },
          plainText: "hi",
          children: [{ type: "not_a_block" }, { type: "quote", plainText: "q" }],
        },
        { type: "not_a_block" },
        "garbage",
      ],
    });
    const blocks = parseInternalPastedBlocks(dataTransfer(payload));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      content: { rich: [{ text: "hi" }] },
      plainText: "hi",
      children: [{ type: "quote", plainText: "q" }],
    });
  });
});
