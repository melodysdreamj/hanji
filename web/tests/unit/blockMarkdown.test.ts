import { describe, expect, it } from "vitest";
import type { Block, BlockContent, BlockType } from "@/lib/types";
import {
  blockMarkdown,
  blockTreeHtml,
  blockTreeMarkdown,
  blocksClipboardHtml,
} from "@/components/editor/blockMarkdown";

let seq = 0;
function makeBlock(
  type: BlockType,
  content?: BlockContent,
  patch: Partial<Block> = {}
): Block {
  return {
    id: `b${++seq}`,
    pageId: "page",
    type,
    content,
    position: seq,
    ...patch,
  } as Block;
}

const richText = (text: string) => ({ rich: [{ text }] });

describe("blockMarkdown", () => {
  it("serializes headings and toggle headings", () => {
    expect(blockMarkdown(makeBlock("heading_1", richText("One")))).toBe("# One");
    expect(blockMarkdown(makeBlock("heading_2", richText("Two")))).toBe("## Two");
    expect(blockMarkdown(makeBlock("heading_3", richText("Three")))).toBe("### Three");
    expect(blockMarkdown(makeBlock("heading_4", richText("Four")))).toBe("#### Four");
    expect(blockMarkdown(makeBlock("toggle_heading_1", richText("T")))).toBe("▶ # T");
  });

  it("serializes lists, to-dos, toggles, quotes, callouts", () => {
    expect(blockMarkdown(makeBlock("bulleted_list_item", richText("b")))).toBe("- b");
    expect(blockMarkdown(makeBlock("numbered_list_item", richText("n")))).toBe("1. n");
    expect(
      blockMarkdown(makeBlock("to_do", { ...richText("t"), checked: true }))
    ).toBe("- [x] t");
    expect(
      blockMarkdown(makeBlock("to_do", { ...richText("t"), checked: false }))
    ).toBe("- [ ] t");
    expect(blockMarkdown(makeBlock("toggle", richText("t")))).toBe("▶ t");
    expect(blockMarkdown(makeBlock("quote", richText("q")))).toBe("> q");
    expect(
      blockMarkdown(makeBlock("callout", { ...richText("c"), icon: "⚠️" }))
    ).toBe("> ⚠️ c");
    expect(blockMarkdown(makeBlock("callout", richText("c")))).toBe("> 💡 c");
  });

  it("serializes inline marks", () => {
    expect(
      blockMarkdown(
        makeBlock("paragraph", {
          rich: [
            { text: "plain " },
            { text: "bold", bold: true },
            { text: " and " },
            { text: "struck", strikethrough: true },
          ],
        })
      )
    ).toBe("plain **bold** and ~~struck~~");
  });

  it("escapes markdown syntax in literal text", () => {
    expect(blockMarkdown(makeBlock("paragraph", richText("a*b_c[d]`e`")))).toBe(
      "a\\*b\\_c\\[d\\]\\`e\\`"
    );
  });

  it("moves edge whitespace outside mark delimiters", () => {
    expect(
      blockMarkdown(makeBlock("paragraph", { rich: [{ text: " padded ", bold: true }, { text: "x" }] }))
    ).toBe(" **padded** x");
  });

  it("serializes inline code with fence padding", () => {
    expect(
      blockMarkdown(makeBlock("paragraph", { rich: [{ text: "a`b", code: true }] }))
    ).toBe("``a`b``");
    expect(
      blockMarkdown(makeBlock("paragraph", { rich: [{ text: "`edge", code: true }] }))
    ).toBe("`` `edge ``");
  });

  it("serializes links and page mentions", () => {
    expect(
      blockMarkdown(makeBlock("paragraph", { rich: [{ text: "site", link: "https://a.io/x y" }] }))
    ).toBe("[site](https://a.io/x%20y)");
    expect(
      blockMarkdown(
        makeBlock("paragraph", { rich: [{ text: "Page", mention: "page", pageId: "p1" }] })
      )
    ).toBe("[Page](/p/p1)");
  });

  it("serializes date and person mentions as notionlike:// links", () => {
    expect(
      blockMarkdown(
        makeBlock("paragraph", {
          rich: [{ text: "@date", mention: "date", date: "2001-06-01" }],
        })
      )
    ).toMatch(/^\[@.*\]\(notionlike:\/\/date\/2001-06-01\)$/);
    expect(
      blockMarkdown(
        makeBlock("paragraph", {
          rich: [{ text: "@June", mention: "person", userId: "u1" }],
        })
      )
    ).toBe("[@June](notionlike://person/u1)");
  });

  it("serializes code blocks with language and growing fences", () => {
    expect(
      blockMarkdown(makeBlock("code", { ...richText("const a = 1;"), language: "ts" }))
    ).toBe("```ts\nconst a = 1;\n```");
    expect(
      blockMarkdown(makeBlock("code", richText("a ```` b")))
    ).toBe("`````\na ```` b\n`````");
  });

  it("keeps code content verbatim (no escaping)", () => {
    expect(blockMarkdown(makeBlock("code", richText("*not markdown*")))).toBe(
      "```\n*not markdown*\n```"
    );
  });

  it("serializes equations, dividers, and tables", () => {
    expect(
      blockMarkdown(makeBlock("equation", { expression: "x^2" }))
    ).toBe("$$\nx^2\n$$");
    expect(blockMarkdown(makeBlock("divider"))).toBe("---");
    expect(
      blockMarkdown(makeBlock("simple_table", { table: [["A", "B"], ["1", "2"]] }))
    ).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
  });

  it("normalizes malformed tables to at least 2x2", () => {
    expect(blockMarkdown(makeBlock("simple_table", { table: [] }))).toBe(
      "|  |  |\n| --- | --- |\n|  |  |"
    );
  });

  it("escapes pipes and newlines inside table cells", () => {
    expect(
      blockMarkdown(makeBlock("simple_table", { table: [["a|b", "c\nd"]] }))
    ).toBe("| a\\|b | c<br>d |\n| --- | --- |");
  });

  it("serializes media blocks", () => {
    expect(
      blockMarkdown(makeBlock("image", { url: "https://a.io/x.png", caption: [{ text: "cap" }] }))
    ).toBe("![cap](https://a.io/x.png)");
    expect(blockMarkdown(makeBlock("image", { url: "javascript:x" }))).toBe("");
    expect(blockMarkdown(makeBlock("video", { url: "https://a.io/v" }))).toBe(
      "[Video](https://a.io/v)"
    );
    expect(blockMarkdown(makeBlock("video", {}))).toBe("[Video]");
    expect(blockMarkdown(makeBlock("bookmark", { url: "https://a.io" }))).toBe(
      "[https://a.io](https://a.io)"
    );
    expect(
      blockMarkdown(makeBlock("file", { url: "https://a.io/f.txt", fileName: "f.txt" }))
    ).toBe("[File: f.txt](https://a.io/f.txt)");
    expect(blockMarkdown(makeBlock("file", { fileName: "f.txt" }))).toBe("f.txt");
  });

  it("serializes page links as wiki links", () => {
    expect(
      blockMarkdown(
        makeBlock("link_to_page", { childPageId: "p1" }, { plainText: "My Page" })
      )
    ).toBe("[[My Page]](/p/p1)");
    expect(blockMarkdown(makeBlock("child_page", {}, { plainText: "" }))).toBe(
      "[[Page]]"
    );
  });

  it("serializes marker blocks", () => {
    expect(blockMarkdown(makeBlock("table_of_contents"))).toBe("[Table of contents]");
    expect(blockMarkdown(makeBlock("breadcrumb"))).toBe("[Breadcrumb]");
    expect(blockMarkdown(makeBlock("synced_block"))).toBe("[Synced block]");
    expect(blockMarkdown(makeBlock("tab"))).toBe("[Tabs]");
    expect(blockMarkdown(makeBlock("button", { buttonLabel: "Go" }))).toBe(
      "[Button: Go]"
    );
  });

  it("handles empty content", () => {
    expect(blockMarkdown(makeBlock("paragraph"))).toBe("");
    expect(blockMarkdown(makeBlock("heading_1"))).toBe("# ");
  });
});

describe("blockTreeMarkdown", () => {
  it("indents children two spaces per depth, sorted by position", () => {
    const root = makeBlock("bulleted_list_item", richText("root"), { id: "root" });
    const childB = makeBlock("bulleted_list_item", richText("b"), {
      id: "cb",
      parentId: "root",
      position: 2,
    });
    const childA = makeBlock("bulleted_list_item", richText("a"), {
      id: "ca",
      parentId: "root",
      position: 1,
    });
    const grandchild = makeBlock("paragraph", richText("deep"), {
      id: "g",
      parentId: "ca",
      position: 1,
    });
    expect(blockTreeMarkdown(root, [root, childB, childA, grandchild])).toBe(
      "- root\n  - a\n    deep\n  - b"
    );
  });

  it("indents every line of multi-line children", () => {
    const root = makeBlock("paragraph", richText("root"), { id: "root" });
    const code = makeBlock("code", richText("x\ny"), { id: "c", parentId: "root" });
    expect(blockTreeMarkdown(root, [root, code])).toBe(
      "root\n  ```\n  x\n  y\n  ```"
    );
  });

  it("serializes tab labels with icons under tab blocks", () => {
    const tab = makeBlock("tab", { rich: [] }, { id: "tab" });
    const label = makeBlock("paragraph", { ...richText("First"), icon: "📁" }, {
      id: "label",
      parentId: "tab",
    });
    expect(blockTreeMarkdown(tab, [tab, label])).toBe("[Tabs]\n  [Tab: 📁 First]");
  });
});

describe("blockTreeHtml", () => {
  it("renders headings with children appended", () => {
    const root = makeBlock("heading_1", richText("Title"), { id: "root" });
    const child = makeBlock("paragraph", richText("body"), {
      id: "child",
      parentId: "root",
    });
    expect(blockTreeHtml(root, [root, child])).toBe("<h1>Title</h1><p>body</p>");
  });

  it("nests list children inside the li", () => {
    const root = makeBlock("bulleted_list_item", richText("item"), { id: "root" });
    const child = makeBlock("bulleted_list_item", richText("sub"), {
      id: "child",
      parentId: "root",
    });
    expect(blockTreeHtml(root, [root, child])).toBe(
      "<ul><li>item<ul><li>sub</li></ul></li></ul>"
    );
  });

  it("renders to_do checkboxes and toggles", () => {
    expect(
      blockTreeHtml(makeBlock("to_do", { ...richText("t"), checked: true }), [])
    ).toBe('<ul><li><input type="checkbox" disabled checked> t</li></ul>');
    expect(blockTreeHtml(makeBlock("toggle", richText("t")), [])).toBe(
      "<details open><summary>t</summary></details>"
    );
  });

  it("escapes html in text content", () => {
    expect(blockTreeHtml(makeBlock("paragraph", richText("<b>&")), [])).toBe(
      "<p>&lt;b&gt;&amp;</p>"
    );
  });

  it("renders code blocks with language classes", () => {
    expect(
      blockTreeHtml(makeBlock("code", { ...richText("let x;"), language: "js" }), [])
    ).toBe('<pre><code class="language-js">let x;</code></pre>');
  });

  it("renders colored blocks with inline clipboard styles", () => {
    expect(
      blockTreeHtml(makeBlock("paragraph", { ...richText("x"), color: "red" }), [])
    ).toBe('<p style="color: rgb(212, 76, 71)">x</p>');
    const highlighted = blockTreeHtml(
      makeBlock("paragraph", { ...richText("x"), color: "yellow_background" }),
      []
    );
    expect(highlighted).toContain("background-color: rgb(251, 243, 219)");
  });

  it("renders simple tables as html tables", () => {
    const html = blockTreeHtml(
      makeBlock("simple_table", { table: [["A"], ["1"]] }),
      []
    );
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
  });

  it("renders images with escaped attributes and skips unsafe urls", () => {
    const html = blockTreeHtml(
      makeBlock("image", { url: "https://a.io/x.png", caption: [{ text: "c" }] }),
      []
    );
    expect(html).toContain('<img src="https://a.io/x.png"');
    expect(blockTreeHtml(makeBlock("image", { url: "javascript:x" }), [])).toBe("");
  });

  it("renders tab labels as data-attributed sections", () => {
    const tab = makeBlock("tab", { rich: [] }, { id: "tab" });
    const label = makeBlock("paragraph", { ...richText("First"), icon: "📁" }, {
      id: "label",
      parentId: "tab",
    });
    const html = blockTreeHtml(tab, [tab, label]);
    expect(html).toContain('data-notionlike-block-type="tab"');
    expect(html).toContain('data-notionlike-tab-label="true"');
    expect(html).toContain('data-notionlike-tab-icon="📁"');
  });
});

describe("blocksClipboardHtml", () => {
  it("wraps content in the copy fragment shell", () => {
    expect(blocksClipboardHtml("<p>x</p>")).toBe(
      '<html><body><!--StartFragment--><div data-notionlike-copy="true"><p>x</p></div><!--EndFragment--></body></html>'
    );
  });
});
