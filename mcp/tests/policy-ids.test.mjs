// Unit tests for collectPolicyIds — the id-extraction step behind
// assertMcpAccessPolicy, the single chokepoint every eb.* backend request
// passes through. A field missed here silently escapes a policy-narrowed
// client's allowlist, so each mapping is pinned explicitly.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collectPolicyIds } from "../src/edgebase.mjs";

describe("collectPolicyIds", () => {
  it("collects generic workspace/page/database ids from any body", () => {
    const ids = collectPolicyIds("/functions/anything", {
      workspaceId: "ws1",
      pageId: "p1",
      databaseId: "db1",
    });
    assert.ok(ids.workspaceIds.has("ws1"));
    assert.ok(ids.pageIds.has("p1"));
    assert.ok(ids.databaseIds.has("db1"));
  });

  it("collects the moved row AND its target sibling for a row move", () => {
    const ids = collectPolicyIds("/functions/database-row-mutation", {
      action: "move",
      id: "row-1",
      targetId: "row-2",
      side: "after",
    });
    assert.ok(ids.pageIds.has("row-1"));
    assert.ok(ids.pageIds.has("row-2"), "move target must be inside the allowlist");
  });

  it("collects a page move's destination parent from the update patch", () => {
    const toPage = collectPolicyIds("/functions/page-mutation", {
      action: "update",
      id: "p1",
      patch: { parentId: "p-dest", parentType: "page", position: 3 },
    });
    assert.ok(toPage.pageIds.has("p1"));
    assert.ok(toPage.pageIds.has("p-dest"), "move destination must be inside the allowlist");

    const toDatabase = collectPolicyIds("/functions/page-mutation", {
      action: "update",
      id: "p1",
      patch: { parentId: "db-dest", parentType: "database" },
    });
    assert.ok(toDatabase.databaseIds.has("db-dest"));
    assert.ok(!toDatabase.pageIds.has("db-dest"));
  });

  it("collects duplicate-page's destination parent", () => {
    const toPage = collectPolicyIds("/functions/duplicate-page", {
      action: "duplicate",
      pageId: "p-src",
      parentId: "p-dest",
      parentType: "page",
    });
    assert.ok(toPage.pageIds.has("p-src"));
    assert.ok(toPage.pageIds.has("p-dest"));

    const toDatabase = collectPolicyIds("/functions/duplicate-page", {
      action: "duplicate",
      pageId: "p-src",
      parentId: "db-dest",
      parentType: "database",
    });
    assert.ok(toDatabase.databaseIds.has("db-dest"));
  });

  it("keeps the pre-existing path-specific mappings intact", () => {
    const create = collectPolicyIds("/functions/page-mutation", {
      action: "create",
      id: "p-new",
      parentId: "db1",
      parentType: "database",
    });
    assert.ok(create.pageIds.has("p-new"));
    assert.ok(create.databaseIds.has("db1"));

    const row = collectPolicyIds("/functions/database-row-mutation", {
      action: "update",
      id: "row-1",
      patch: { title: "x" },
    });
    assert.ok(row.pageIds.has("row-1"));
  });

  it("collects createDatabase's destination parent from the top-level body", () => {
    const toPage = collectPolicyIds("/functions/database-mutation", {
      action: "createDatabase",
      parentId: "p-dest",
      parentType: "page",
    });
    assert.ok(toPage.pageIds.has("p-dest"), "createDatabase parent must be inside the allowlist");
    assert.ok(!toPage.databaseIds.has("p-dest"));

    const toDatabase = collectPolicyIds("/functions/database-mutation", {
      action: "createDatabase",
      parentId: "db-dest",
      parentType: "database",
    });
    assert.ok(toDatabase.databaseIds.has("db-dest"));
    assert.ok(!toDatabase.pageIds.has("db-dest"));
  });

  it("collects an import-export destination parent", () => {
    const toPage = collectPolicyIds("/functions/import-export", {
      action: "import",
      parentId: "p-dest",
      parentType: "page",
    });
    assert.ok(toPage.pageIds.has("p-dest"), "import destination must be inside the allowlist");

    const toDatabase = collectPolicyIds("/functions/import-export", {
      action: "import",
      parentId: "db-dest",
      parentType: "database",
    });
    assert.ok(toDatabase.databaseIds.has("db-dest"));
    assert.ok(!toDatabase.pageIds.has("db-dest"));
  });

  it("collects a relation property's target database from record.config", () => {
    const ids = collectPolicyIds("/functions/database-mutation", {
      action: "addProperty",
      record: { config: { relationDatabaseId: "db-rel" } },
    });
    assert.ok(ids.databaseIds.has("db-rel"), "relation target must be inside the allowlist");
  });

  it("captures a block update/delete target so a bare id cannot bypass the allowlist", () => {
    // eb.update("blocks", id, patch) / eb.del("blocks", id) send no pageId. A
    // policy-narrowed client must not be able to mutate an arbitrary block by
    // passing a bare id — the id itself must land in an id set so the allowlist
    // check runs instead of early-returning on an empty set.
    const update = collectPolicyIds("/functions/block-mutation", {
      action: "update",
      id: "block-1",
      patch: { content: { rich: [] } },
    });
    assert.ok(update.pageIds.has("block-1"), "block update target must be captured");

    const del = collectPolicyIds("/functions/block-mutation", {
      action: "delete",
      id: "block-2",
    });
    assert.ok(del.pageIds.has("block-2"), "block delete target must be captured");
  });

  it("captures a comment update/delete target so a bare id cannot bypass the allowlist", () => {
    const update = collectPolicyIds("/functions/comment-mutation", {
      action: "update",
      id: "comment-1",
      patch: { resolved: true },
    });
    assert.ok(update.pageIds.has("comment-1"), "comment update target must be captured");

    const del = collectPolicyIds("/functions/comment-mutation", {
      action: "delete",
      id: "comment-2",
    });
    assert.ok(del.pageIds.has("comment-2"), "comment delete target must be captured");
  });

  it("prefers the owning pageId over the bare id when a block/comment mutation carries one", () => {
    // When the caller threads the owning pageId (the resolvable page anchor),
    // the allowlist check validates that page rather than the unresolvable
    // block/comment id, so legitimate narrowed mutations still succeed.
    const block = collectPolicyIds("/functions/block-mutation", {
      action: "delete",
      id: "block-1",
      pageId: "page-1",
    });
    assert.ok(block.pageIds.has("page-1"));
    assert.ok(!block.pageIds.has("block-1"));

    const comment = collectPolicyIds("/functions/comment-mutation", {
      action: "update",
      id: "comment-1",
      pageId: "page-1",
      patch: { resolved: true },
    });
    assert.ok(comment.pageIds.has("page-1"));
    assert.ok(!comment.pageIds.has("comment-1"));
  });

  it("does not capture a block/comment create's bare id (only update/delete target existing ids)", () => {
    const create = collectPolicyIds("/functions/block-mutation", {
      action: "create",
      id: "new-block",
      pageId: "page-1",
    });
    assert.ok(create.pageIds.has("page-1"));
    assert.ok(!create.pageIds.has("new-block"), "a freshly-minted create id is not an existing resource");
  });

  it("captures page-query's bare comment read target so it cannot bypass the allowlist", () => {
    // eb.getOne("comments", id) sends { action: "comment", commentId } with no
    // pageId. The bare id must land in an id set so the allowlist check runs
    // instead of early-returning — otherwise a policy-narrowed client could
    // read ANY comment (reached via resolve_comment).
    const ids = collectPolicyIds("/functions/page-query", {
      action: "comment",
      commentId: "comment-1",
    });
    assert.ok(ids.pageIds.has("comment-1"), "comment read target must be captured");
  });

  it("prefers the owning pageId when a page-query comment read carries one", () => {
    const ids = collectPolicyIds("/functions/page-query", {
      action: "comment",
      commentId: "comment-1",
      pageId: "page-1",
    });
    assert.ok(ids.pageIds.has("page-1"));
    assert.ok(!ids.pageIds.has("comment-1"));
  });

  it("ignores non-string and absent fields", () => {
    const ids = collectPolicyIds("/functions/database-row-mutation", {
      action: "move",
      id: "row-1",
      targetId: 42,
    });
    assert.ok(!ids.pageIds.has("42"));
    const empty = collectPolicyIds("/functions/page-mutation", { action: "update", id: "p1" });
    assert.equal(empty.pageIds.size, 1);
  });
});
