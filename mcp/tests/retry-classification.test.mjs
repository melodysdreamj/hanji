// Unit tests for retryableHttpStatuses — the classification that decides which
// HTTP statuses a backend call may retry. 504 is ambiguous for mutations (the
// gateway can time out AFTER the write committed, so replaying a
// non-idempotent POST duplicates appends/imports); only read-only calls may
// retry it. 429/503 are emitted before any work commits, so both classes
// retry them.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { retryableHttpStatuses } from "../src/edgebase.mjs";

describe("retryableHttpStatuses", () => {
  it("lets GET requests retry 504", () => {
    const statuses = retryableHttpStatuses("/functions/anything", "GET");
    assert.ok(statuses.has(429));
    assert.ok(statuses.has(503));
    assert.ok(statuses.has(504));
  });

  it("lets read-only functions and actions retry 504", () => {
    for (const [path, body] of /** @type {[string, any][]} */ ([
      ["/functions/page-query", { action: "blocks", pageId: "p1" }],
      ["/functions/page-query", { action: "searchPages", query: "x" }],
      ["/functions/workspace-bootstrap", {}],
      ["/functions/workspace-mutation", { action: "list" }],
      ["/functions/import-export", { action: "exportPageMarkdown", pageId: "p1" }],
      ["/functions/notion-import", { action: "get", jobId: "j1" }],
      ["/functions/file-mutation", { action: "signedUrl", workspaceId: "ws1", uploadId: "u1" }],
    ])) {
      const statuses = retryableHttpStatuses(path, "POST", body);
      assert.ok(statuses.has(504), `${path} ${body.action ?? ""} should retry 504`);
    }
  });

  it("keeps mutations away from 504 but still retries 429/503", () => {
    for (const [path, body] of /** @type {[string, any][]} */ ([
      ["/functions/import-export", { action: "appendMarkdownToPage", pageId: "p1", markdown: "x" }],
      ["/functions/import-export", { action: "importMarkdownPage", markdown: "x" }],
      ["/functions/block-mutation", { action: "create", pageId: "p1" }],
      ["/functions/page-mutation", { action: "update", id: "p1", patch: {} }],
      ["/functions/database-row-mutation", { action: "create", databaseId: "db1" }],
      ["/functions/workspace-mutation", { action: "createWorkspace", name: "W" }],
      ["/functions/comment-mutation", { action: "create", pageId: "p1" }],
    ])) {
      const statuses = retryableHttpStatuses(path, "POST", body);
      assert.ok(!statuses.has(504), `${path} ${body.action ?? ""} must NOT retry 504`);
      assert.ok(statuses.has(429), `${path} still retries 429`);
      assert.ok(statuses.has(503), `${path} still retries 503`);
    }
  });
});
