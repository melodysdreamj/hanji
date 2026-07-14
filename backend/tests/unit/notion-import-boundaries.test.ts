import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function lines(value: string) {
  return value.split(/\r?\n/).length;
}

describe("Notion import architecture boundaries", () => {
  it("keeps credential crypto and metadata scrubbing out of the function orchestrator", () => {
    const importer = readFileSync(new URL("../../functions/notion-import.ts", import.meta.url), "utf8");
    expect(importer).not.toContain("function credentialCryptoKey(");
    expect(importer).not.toContain("function sanitizeNotionCredentialMetadata(");
    expect(importer).toContain("../lib/notion-import-credentials");
    expect(importer).toContain("../lib/notion-import-metadata");
  });

  it("keeps payload limits and retrying Notion transport out of the orchestrator", () => {
    const importer = readFileSync(new URL("../../functions/notion-import.ts", import.meta.url), "utf8");
    expect(importer).not.toContain("class NotionApiError");
    expect(importer).not.toContain("async function notionRequest(");
    expect(importer).not.toContain("function parseImportSnapshotPayload(");
    expect(importer).not.toContain("function parseMcpFetchItems(");
    expect(importer).not.toContain("function collectMcpFetchPayloads(");
    expect(importer).toContain("../lib/notion-api-client");
    expect(importer).toContain("../lib/notion-import-request-limits");
    expect(importer).toContain("../lib/notion-import-mcp-snapshot");
  });

  it("keeps the import orchestrator inside its current size budget", () => {
    const importer = readFileSync(new URL("../../functions/notion-import.ts", import.meta.url), "utf8");
    expect(importer).not.toContain("async function applyJobCoreWithRuntime(");
    expect(importer).not.toContain("function buildImportPlan(job");
    expect(importer).toContain("return discoverNotionGraphWithRuntime(token, options, notionImportDiscoveryRuntime)");
    expect(importer).toContain("return preflightNotionImportGraphWithRuntime(token, options, notionImportDiscoveryRuntime)");
    expect(importer).toContain("../lib/notion-import-discovery");
    expect(importer).toContain("../lib/notion-import-apply");
    expect(importer).toContain("../lib/notion-import-plan");
    expect(lines(importer)).toBeLessThanOrEqual(13_200);
    const mcpSnapshot = readFileSync(
      new URL("../../lib/notion-import-mcp-snapshot.ts", import.meta.url),
      "utf8"
    );
    expect(lines(mcpSnapshot)).toBeLessThanOrEqual(1_100);
    const discovery = readFileSync(
      new URL("../../lib/notion-import-discovery.ts", import.meta.url),
      "utf8"
    );
    const apply = readFileSync(
      new URL("../../lib/notion-import-apply.ts", import.meta.url),
      "utf8"
    );
    const plan = readFileSync(
      new URL("../../lib/notion-import-plan.ts", import.meta.url),
      "utf8"
    );
    expect(lines(discovery)).toBeLessThanOrEqual(1_100);
    expect(lines(apply)).toBeLessThanOrEqual(1_350);
    expect(lines(plan)).toBeLessThanOrEqual(600);
  });
});
