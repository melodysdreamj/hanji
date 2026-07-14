import { describe, expect, it } from "vitest";
import {
  cloneInlineScopedViewConfig,
  filterViewsByNotionLinkedDatabaseTargets,
  orderImportedInlineViewsForNotionChrome,
} from "@/components/database/importedViewModel";
import type { DbView } from "@/lib/types";

function makeView(overrides: Partial<DbView> & Pick<DbView, "id">): DbView {
  return {
    config: {},
    databaseId: "db-1",
    id: overrides.id,
    name: "Default view",
    position: 1,
    type: "table",
    ...overrides,
  } as DbView;
}

describe("imported view model", () => {
  it("clones product view settings without leaking Notion import ownership", () => {
    const config = cloneInlineScopedViewConfig(
      {
        filters: [{ propertyId: "status", operator: "equals", value: "done" }],
        notionViewId: "source-view",
        notion: { created_time: "2024-01-01T00:00:00.000Z" },
        unresolvedPropertyReferences: ["legacy"],
      },
      "inline-block",
      "source-view"
    );

    expect(config.filters).toHaveLength(1);
    expect(config.inlineDatabaseBlockId).toBe("inline-block");
    expect(config.inlineDatabaseSourceViewId).toBe("source-view");
    expect(config.notionViewId).toBeUndefined();
    expect(config.notion).toBeUndefined();
    expect(config.unresolvedPropertyReferences).toBeUndefined();
  });

  it("filters linked views by normalized Notion database identity", () => {
    const matching = makeView({
      id: "matching",
      config: { notion: { parent: { database_id: "ab-cd" } }, notionViewId: "n1" },
    });
    const unrelated = makeView({
      id: "unrelated",
      config: { notion: { parent: { database_id: "ef-gh" } }, notionViewId: "n2" },
    });

    expect(filterViewsByNotionLinkedDatabaseTargets([matching, unrelated], ["collection://abcd"]))
      .toEqual([matching]);
  });

  it("restores imported tab order from authoritative Notion creation time", () => {
    const views = [4, 1, 2, 3].map((created, index) =>
      makeView({
        id: `view-${created}`,
        name: index === 0 ? "Default view" : `View ${created}`,
        position: index,
        config: {
          notionViewId: `notion-${created}`,
          notion: { created_time: `2024-01-0${created}T00:00:00.000Z` },
        },
      })
    );

    expect(orderImportedInlineViewsForNotionChrome(views).map((view) => view.id)).toEqual([
      "view-1",
      "view-2",
      "view-3",
      "view-4",
    ]);
  });
});
