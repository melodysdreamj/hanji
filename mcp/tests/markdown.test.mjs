// Unit tests for the markdown ↔ block conversion layer in src/edgebase.mjs.
// This serialization is the MCP server's page-body wire format, so regressions
// here silently corrupt agent reads/writes even when the stdio smoke passes.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  blockToMarkdown,
  blocksToMarkdown,
  markdownToBlocks,
  spansToPlain,
} from "../src/edgebase.mjs";

const rich = (text) => [{ text }];

describe("blockToMarkdown", () => {
  it("renders headings by level", () => {
    assert.equal(blockToMarkdown({ type: "heading_1", content: { rich: rich("Title") } }), "# Title");
    assert.equal(blockToMarkdown({ type: "heading_3", content: { rich: rich("Deep") } }), "### Deep");
  });

  it("renders to_do checked state", () => {
    assert.equal(
      blockToMarkdown({ type: "to_do", content: { rich: rich("task"), checked: true } }),
      "- [x] task",
    );
    assert.equal(
      blockToMarkdown({ type: "to_do", content: { rich: rich("task"), checked: false } }),
      "- [ ] task",
    );
  });

  it("renders callout with its icon and quote without one", () => {
    assert.equal(
      blockToMarkdown({ type: "callout", content: { rich: rich("note"), icon: "⚠️" } }),
      "> ⚠️ note",
    );
    assert.equal(blockToMarkdown({ type: "quote", content: { rich: rich("wise") } }), "> wise");
  });

  it("renders code fences with language and caption", () => {
    const block = {
      type: "code",
      content: { rich: rich("const x = 1;"), language: "ts", caption: rich("sample") },
    };
    assert.equal(blockToMarkdown(block), "```ts\nconst x = 1;\n```\n_sample_");
  });

  it("keeps code content literal instead of re-escaping markdown", () => {
    const block = { type: "code", content: { rich: rich("**not bold**"), language: "" } };
    assert.equal(blockToMarkdown(block), "```\n**not bold**\n```");
  });

  it("renders equations as $$ blocks", () => {
    assert.equal(
      blockToMarkdown({ type: "equation", content: { expression: "e = mc^2" } }),
      "$$\ne = mc^2\n$$",
    );
  });

  it("drops unsafe image/bookmark urls instead of emitting javascript: links", () => {
    assert.equal(
      blockToMarkdown({ type: "image", content: { url: "javascript:alert(1)", caption: [] } }),
      "",
    );
    assert.equal(
      blockToMarkdown({ type: "bookmark", content: { url: "javascript:alert(1)" } }),
      "",
    );
    assert.equal(
      blockToMarkdown({ type: "image", content: { url: "https://example.com/a.png", caption: rich("cap") } }),
      "![cap](https://example.com/a.png)",
    );
  });

  it("escapes markdown metacharacters in link labels", () => {
    const md = blockToMarkdown({
      type: "file",
      content: { url: "https://example.com/f.pdf", fileName: "a[b]*c.pdf" },
    });
    assert.equal(md, "[File: a\\[b\\]\\*c.pdf](https://example.com/f.pdf)");
  });
});

describe("blocksToMarkdown", () => {
  it("orders siblings by position and indents children", () => {
    const blocks = [
      { id: "b", parentId: null, position: 2, type: "paragraph", content: { rich: rich("second") } },
      { id: "a", parentId: null, position: 1, type: "bulleted_list_item", content: { rich: rich("first") } },
      { id: "a1", parentId: "a", position: 1, type: "bulleted_list_item", content: { rich: rich("child") } },
    ];
    assert.equal(blocksToMarkdown(blocks), "- first\n  - child\nsecond");
  });

  it("renders column lists as ::: columns fences", () => {
    const blocks = [
      { id: "cl", parentId: null, position: 1, type: "column_list", content: {} },
      { id: "c1", parentId: "cl", position: 1, type: "column", content: {} },
      { id: "p1", parentId: "c1", position: 1, type: "paragraph", content: { rich: rich("left") } },
      { id: "c2", parentId: "cl", position: 2, type: "column", content: {} },
      { id: "p2", parentId: "c2", position: 1, type: "paragraph", content: { rich: rich("right") } },
    ];
    const md = blocksToMarkdown(blocks);
    assert.match(md, /::: columns/);
    assert.match(md, /::: column 1\n {2}left/);
    assert.match(md, /::: column 2\n {2}right/);
  });
});

describe("markdownToBlocks", () => {
  it("parses headings, lists, and to_dos", () => {
    const blocks = markdownToBlocks("# H1\n- bullet\n1. numbered\n- [x] done");
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading_1", "bulleted_list_item", "numbered_list_item", "to_do"],
    );
    assert.equal(blocks[3].content.checked, true);
  });

  it("keeps stray backticks inside a code fence", () => {
    const blocks = markdownToBlocks("```js\nconst s = `tpl`;\n```");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "code");
    assert.equal(blocks[0].content.language, "js");
    assert.equal(spansToPlain(blocks[0].content.rich), "const s = `tpl`;");
  });

  it("parses $$ equation blocks", () => {
    const blocks = markdownToBlocks("$$\n\\frac{a}{b}\n$$");
    assert.equal(blocks[0].type, "equation");
    assert.equal(blocks[0].content.expression, "\\frac{a}{b}");
  });

  it("parses pipe tables with a separator row", () => {
    const blocks = markdownToBlocks("| a | b |\n| --- | --- |\n| 1 | 2 |");
    assert.equal(blocks[0].type, "simple_table");
    assert.deepEqual(blocks[0].content.table, [
      ["a", "b"],
      ["1", "2"],
    ]);
    assert.equal(blocks[0].content.headerRow, true);
  });

  it("distinguishes emoji callouts from plain quotes", () => {
    const [callout, quote] = markdownToBlocks("> 💡 tip\n> plain quote");
    assert.equal(callout.type, "callout");
    assert.equal(callout.content.icon, "💡");
    assert.equal(quote.type, "quote");
  });

  it("parses toggle headings by marker depth", () => {
    const blocks = markdownToBlocks("▶ # One\n▶ ### Three\n▶ plain");
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["toggle_heading_1", "toggle_heading_3", "toggle"],
    );
  });

  it("skips blank lines instead of emitting empty paragraphs", () => {
    const blocks = markdownToBlocks("one\n\n\ntwo");
    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks.map((b) => b.type), ["paragraph", "paragraph"]);
  });

  it("parses media and page-link shorthands", () => {
    const blocks = markdownToBlocks(
      "[Video](https://example.com/v.mp4)\n[File: doc.pdf](https://example.com/doc.pdf)\n[[Roadmap]](/p/page-1)\n---",
    );
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["video", "file", "link_to_page", "divider"],
    );
    assert.equal(blocks[1].content.fileName, "doc.pdf");
    assert.equal(blocks[2].content.childPageId, "page-1");
  });
});

describe("markdownToBlocks nesting", () => {
  it("nests an indented bullet under its parent instead of a literal paragraph", () => {
    const blocks = markdownToBlocks("- parent\n  - child");
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].type, "bulleted_list_item");
    assert.equal(spansToPlain(blocks[0].content.rich), "parent");
    assert.ok(Array.isArray(blocks[0].children));
    assert.equal(blocks[0].children.length, 1);
    assert.equal(blocks[0].children[0].type, "bulleted_list_item");
    assert.equal(spansToPlain(blocks[0].children[0].content.rich), "child");
  });

  it("preserves one level of nesting when round-tripping through blocksToMarkdown", () => {
    const flat = [
      { id: "a", parentId: null, position: 1, type: "bulleted_list_item", content: { rich: rich("Parent") } },
      { id: "a1", parentId: "a", position: 1, type: "bulleted_list_item", content: { rich: rich("Child") } },
      { id: "b", parentId: null, position: 2, type: "numbered_list_item", content: { rich: rich("Step") } },
      { id: "b1", parentId: "b", position: 1, type: "numbered_list_item", content: { rich: rich("Sub") } },
      { id: "t", parentId: null, position: 3, type: "toggle", content: { rich: rich("Toggle") } },
      { id: "t1", parentId: "t", position: 1, type: "paragraph", content: { rich: rich("Inside") } },
    ];
    const md = blocksToMarkdown(flat);
    const parsed = markdownToBlocks(md);

    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed.map((b) => b.type), [
      "bulleted_list_item",
      "numbered_list_item",
      "toggle",
    ]);
    assert.equal(parsed[0].children?.[0]?.type, "bulleted_list_item");
    assert.equal(spansToPlain(parsed[0].children[0].content.rich), "Child");
    assert.equal(parsed[1].children?.[0]?.type, "numbered_list_item");
    assert.equal(spansToPlain(parsed[1].children[0].content.rich), "Sub");
    assert.equal(parsed[2].children?.[0]?.type, "paragraph");
    assert.equal(spansToPlain(parsed[2].children[0].content.rich), "Inside");
  });
});

describe("markdown round trip", () => {
  it("is stable for a representative document", () => {
    const source = [
      "# Title",
      "paragraph text",
      "- [ ] open task",
      "- [x] closed task",
      "> 💡 callout",
      "> quote",
      "```py",
      "print('hi')",
      "```",
      "---",
    ].join("\n");

    const withIds = markdownToBlocks(source).map((block, index) => ({
      ...block,
      id: `b${index}`,
      parentId: null,
      position: index + 1,
    }));
    const rendered = blocksToMarkdown(withIds);
    assert.equal(rendered, source);

    // Second pass must be a fixed point: parse(render(x)) === parse-shape of x.
    const reparsed = markdownToBlocks(rendered);
    assert.deepEqual(
      reparsed.map((b) => b.type),
      withIds.map((b) => b.type),
    );
  });
});

describe("spansToPlain", () => {
  it("concatenates span text and tolerates empty input", () => {
    assert.equal(spansToPlain([{ text: "a" }, { text: "b" }]), "ab");
    assert.equal(spansToPlain(undefined), "");
  });
});
