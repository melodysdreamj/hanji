import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relativeUrl: string) {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

function lines(value: string) {
  return value.split(/\r?\n/).length;
}

describe("architecture boundaries", () => {
  it("keeps record-cache key construction out of the store", () => {
    const store = source("../../src/lib/store.ts");
    for (const prefix of [
      "bootstrap:",
      "blocks:",
      "blocksStamp:",
      "dbMetaStamp:",
      "props:",
      "views:",
      "templates:",
      "rows:",
      "rowsKeys:",
      "rowsdata:",
      "rowsrelated:",
    ]) {
      expect(store).not.toContain(`\`${prefix}\${`);
    }
    expect(store).toContain('from "./recordCacheKeys"');
  });

  it("keeps entity, view-config, starter-schema, and mutation policies out of the store", () => {
    const store = source("../../src/lib/store.ts");
    expect(store).not.toContain("function persistablePagePatch(");
    expect(store).not.toContain("function remapViewConfigPropertyIds(");
    expect(store).not.toContain("function optimisticStarterDatabaseSchema(");
    expect(store).not.toContain("async function runAcknowledgedMutation(");
    expect(store).toContain('from "./storeEntityPolicy"');
    expect(store).toContain('from "./databaseViewConfigModel"');
    expect(store).toContain('from "./starterDatabaseModel"');
    expect(store).toContain('from "./mutationLifecycle"');
    expect(store).not.toContain("async loadDatabase(dbId");
    expect(store).not.toContain("async addProperty(dbId");
    expect(store).not.toContain("async addRow(dbId");
    expect(store).toContain('from "./databaseStoreSlice"');
    expect(store).not.toContain("async createPage(opts)");
    expect(store).not.toContain("async deletePage(id)");
    expect(store).not.toContain("async loadBlocks(pageId, opts)");
    expect(store).not.toContain("async undoBlockChange(pageId)");
    expect(store).toContain('from "./pageStoreSlice"');
    expect(store).toContain('from "./blockStoreSlice"');
  });

  it("keeps extracted editor models out of the BlockItem renderer", () => {
    const blockItem = source("../../src/components/editor/BlockItem.tsx");
    const textBlock = source("../../src/components/editor/TextBlock.tsx");
    expect(blockItem).not.toContain("function mentionCalendar(");
    expect(blockItem).not.toContain("function providerEmbedUrl(");
    expect(blockItem).not.toContain("function parseInlineMarkdown(");
    expect(blockItem).not.toContain("function SimpleTableContent(");
    expect(blockItem).not.toContain("function TextBlock(");
    expect(blockItem).not.toContain("function MentionMenu(");
    expect(blockItem).toContain('from "./TextBlock"');
    expect(blockItem).toContain('from "./BlockPickerMenus"');
    expect(textBlock).toContain('from "./mentionCalendarModel"');
    expect(blockItem).toContain('from "./mediaEmbeds"');
    expect(textBlock).toContain('from "./editorInputModel"');
    expect(blockItem).toContain('from "./SimpleTableContent"');
  });

  it("keeps Notion import compatibility rules out of DatabaseView", () => {
    const databaseView = source("../../src/components/database/DatabaseView.tsx");
    expect(databaseView).not.toContain("function isImportedNotionView(");
    expect(databaseView).not.toContain("function orderImportedInlineViewsForNotionChrome(");
    expect(databaseView).not.toContain("function databaseViewLabels(");
    expect(databaseView).not.toContain("function FilterGroupEditor(");
    expect(databaseView).not.toContain("function DatabaseToolbar(");
    expect(databaseView).toContain('from "./importedViewModel"');
    expect(databaseView).toContain('from "./databaseViewLabels"');
    expect(databaseView).toContain('from "./DatabaseFilterEditors"');
    expect(databaseView).toContain('from "./DatabaseToolbar"');
  });

  it("keeps the original orchestration modules inside their current size budgets", () => {
    expect(lines(source("../../src/lib/store.ts"))).toBeLessThanOrEqual(6_100);
    expect(lines(source("../../src/lib/pageStoreSlice.ts"))).toBeLessThanOrEqual(1_200);
    expect(lines(source("../../src/lib/blockStoreSlice.ts"))).toBeLessThanOrEqual(1_100);
    expect(lines(source("../../src/lib/databaseStoreSlice.ts"))).toBeLessThanOrEqual(2_700);
    expect(lines(source("../../src/components/editor/BlockItem.tsx"))).toBeLessThanOrEqual(6_000);
    expect(lines(source("../../src/components/editor/TextBlock.tsx"))).toBeLessThanOrEqual(3_200);
    expect(lines(source("../../src/components/editor/BlockPickerMenus.tsx"))).toBeLessThanOrEqual(900);
    expect(lines(source("../../src/components/database/DatabaseView.tsx"))).toBeLessThanOrEqual(2_800);
    expect(lines(source("../../src/components/database/DatabaseToolbar.tsx"))).toBeLessThanOrEqual(3_200);
  });
});
