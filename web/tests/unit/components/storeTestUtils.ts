// Shared store seeding/reset helpers for component tests. Test files must
// still declare their own `vi.mock("@/lib/edgebase", ...)` before importing
// this module (vi.mock is hoisted per test file), so the store below is
// always created against the mocked network layer.
import { useStore } from "@/lib/store";
import type { DbProperty, Page } from "@/lib/types";

// jsdom does not implement scrollIntoView; several components call it from
// reveal-on-focus/active effects.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

export const TEST_USER = "user-test";

const FIXTURE_NOW = new Date().toISOString();

// Full state snapshot taken before any test mutates the store. Includes the
// store's action functions, so replacing with it restores a pristine store.
const initialState = useStore.getState();

export function resetStore() {
  useStore.setState({ ...initialState }, true);
  window.localStorage.clear();
}

export function makePage(overrides: Partial<Page> & { id: string }): Page {
  return {
    workspaceId: "ws-1",
    parentId: null,
    parentType: "workspace",
    kind: "page",
    title: "Untitled",
    iconType: "none",
    position: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    createdBy: TEST_USER,
    ...overrides,
  };
}

export function makeRow(dbId: string, overrides: Partial<Page> & { id: string }): Page {
  return makePage({ parentId: dbId, parentType: "database", ...overrides });
}

export function makeProp(
  dbId: string,
  overrides: Partial<DbProperty> & { id: string; type: DbProperty["type"] }
): DbProperty {
  return {
    databaseId: dbId,
    name: overrides.id,
    position: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function seedPages(pages: Page[]) {
  useStore.setState((s) => ({
    pagesById: {
      ...s.pagesById,
      ...Object.fromEntries(pages.map((page) => [page.id, page])),
    },
  }));
}

export function seedDbProps(dbId: string, props: DbProperty[]) {
  useStore.setState((s) => ({ propsByDb: { ...s.propsByDb, [dbId]: props } }));
}

export function seedUser(userId: string = TEST_USER) {
  useStore.setState({ userId });
}
