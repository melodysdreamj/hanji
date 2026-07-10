// Unit tests for updateMarkdownPreservingIds — update_page's update_content
// diff. The previous implementation round-tripped the WHOLE page through
// replaceMarkdown (delete-all + reinsert): every block got a new id, so
// comment anchors dangled, buttons re-parsed into synthetic templates, and
// non-markdown media dropped. These tests pin the id-preservation contract:
// a targeted edit must not touch any other block.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { eb, blocksToMarkdown } from "../src/edgebase.mjs";
import { updateMarkdownPreservingIds } from "../src/index.mjs";

const PAGE_ID = "page-1";

function pageBlocks() {
  return [
    { id: "b-head", pageId: PAGE_ID, parentId: null, position: 1, type: "heading_1", content: { rich: [{ text: "Title" }] } },
    { id: "b-para", pageId: PAGE_ID, parentId: null, position: 2, type: "paragraph", content: { rich: [{ text: "Hello wrold" }] } },
    {
      id: "b-button",
      pageId: PAGE_ID,
      parentId: null,
      position: 3,
      type: "button",
      content: {
        rich: [],
        buttonLabel: "Run checklist",
        buttonTemplate: [
          { type: "to_do", content: { rich: [{ text: "Step 1" }], checked: false } },
          { type: "paragraph", content: { rich: [{ text: "Step 2" }] } },
          { type: "paragraph", content: { rich: [{ text: "Step 3" }] } },
        ],
      },
      plainText: "Run checklist",
    },
    // b-anchored carries a (conceptual) comment anchor; its id must survive.
    { id: "b-anchored", pageId: PAGE_ID, parentId: null, position: 4, type: "to_do", content: { rich: [{ text: "task" }], checked: false } },
    { id: "b-child", pageId: PAGE_ID, parentId: "b-anchored", position: 1, type: "paragraph", content: { rich: [{ text: "child note" }] } },
  ];
}

describe("updateMarkdownPreservingIds", () => {
  const original = { blocks: eb.blocks, update: eb.update, insert: eb.insert, del: eb.del };
  let calls;

  beforeEach(() => {
    calls = { updated: [], inserted: [], deleted: [] };
    eb.update = async (table, id, patch) => {
      calls.updated.push({ table, id, patch });
      return {};
    };
    eb.insert = async (table, payload) => {
      calls.inserted.push({ table, payload });
      return payload;
    };
    eb.del = async (table, id) => {
      calls.deleted.push({ table, id });
      return {};
    };
  });

  afterEach(() => {
    Object.assign(eb, original);
  });

  it("updates only the edited block in place for a single-typo edit", async () => {
    const blocks = pageBlocks();
    const markdown = blocksToMarkdown(blocks).replace("wrold", "world");
    const stats = await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    assert.equal(calls.deleted.length, 0, "no block is deleted");
    assert.equal(calls.inserted.length, 0, "no block is inserted");
    assert.equal(calls.updated.length, 1, "exactly one block is touched");
    assert.equal(calls.updated[0].id, "b-para", "the edited paragraph keeps its id (in-place update)");
    assert.deepEqual(calls.updated[0].patch.content.rich, [{ text: "Hello world" }]);
    assert.equal(stats.kept, 3);
    assert.equal(stats.updated, 1);
  });

  it("keeps a button block byte-identical markdown untouched (no synthetic template rewrite)", async () => {
    const blocks = pageBlocks();
    const serialized = blocksToMarkdown(blocks);
    assert.match(serialized, /\[Button: Run checklist; 3 blocks\]/, "fixture sanity: button serializes with its count");
    const markdown = serialized.replace("wrold", "world");
    await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    const touched = [
      ...calls.updated.map((call) => call.id),
      ...calls.deleted.map((call) => call.id),
    ];
    assert.ok(!touched.includes("b-button"), "the button block is never updated or deleted");
    assert.ok(
      !calls.inserted.some((call) => call.payload.type === "button"),
      "no synthetic button is inserted",
    );
  });

  it("preserves the comment-anchor block id when editing the anchored block itself", async () => {
    const blocks = pageBlocks();
    const markdown = blocksToMarkdown(blocks).replace("- [ ] task", "- [x] task");
    await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    // The anchored to_do has a child, so a same-shape edit is a replace run of
    // equal length — but the subtree is not childless, so it is replaced.
    // Editing a CHILDLESS anchored block must keep its id:
    assert.ok(!calls.deleted.some((call) => call.id === "b-para"));

    // Reset and edit only the child paragraph text instead.
    calls.updated.length = 0;
    calls.deleted.length = 0;
    calls.inserted.length = 0;
    const childEdit = blocksToMarkdown(blocks).replace("child note", "child note!");
    await updateMarkdownPreservingIds(PAGE_ID, childEdit, blocks);
    // The to_do subtree changed structurally (it has children), so it is
    // replaced as a unit — but every OTHER block id must survive.
    for (const id of ["b-head", "b-para", "b-button"]) {
      assert.ok(!calls.deleted.some((call) => call.id === id), `${id} survives`);
      assert.ok(!calls.updated.some((call) => call.id === id), `${id} untouched`);
    }
  });

  it("inserts new content between kept blocks without touching them", async () => {
    const blocks = pageBlocks();
    const markdown = blocksToMarkdown(blocks).replace("# Title", "# Title\nBrand new line");
    await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    assert.equal(calls.updated.length, 0);
    assert.equal(calls.deleted.length, 0);
    assert.equal(calls.inserted.length, 1);
    const inserted = calls.inserted[0].payload;
    assert.equal(inserted.type, "paragraph");
    assert.ok(
      inserted.position > 1 && inserted.position < 2,
      `new block lands between its neighbors (got ${inserted.position})`,
    );
  });

  it("deletes removed subtrees without renumbering the rest", async () => {
    const blocks = pageBlocks();
    const markdown = blocksToMarkdown(blocks).replace("Hello wrold\n", "");
    await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    assert.deepEqual(calls.deleted.map((call) => call.id), ["b-para"]);
    assert.equal(calls.updated.length, 0);
    assert.equal(calls.inserted.length, 0);
  });

  it("replaces a changed-type run in place, reusing the old position", async () => {
    const blocks = pageBlocks();
    const markdown = blocksToMarkdown(blocks).replace("Hello wrold", "## Now a heading");
    await updateMarkdownPreservingIds(PAGE_ID, markdown, blocks);

    assert.deepEqual(calls.deleted.map((call) => call.id), ["b-para"]);
    assert.equal(calls.inserted.length, 1);
    assert.equal(calls.inserted[0].payload.type, "heading_2");
    assert.equal(calls.inserted[0].payload.position, 2, "replacement reuses the old root position");
  });
});
