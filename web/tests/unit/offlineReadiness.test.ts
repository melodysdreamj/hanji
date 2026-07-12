// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  cacheGetMeta,
  cacheListTable,
  cacheWorkspaceFilesForOffline,
  getOfflinePins,
  hasCachedWorkspaceFiles,
} = vi.hoisted(() => ({
  cacheGetMeta: vi.fn(),
  cacheListTable: vi.fn(),
  cacheWorkspaceFilesForOffline: vi.fn(async () => true),
  getOfflinePins: vi.fn(async () => ({})),
  hasCachedWorkspaceFiles: vi.fn(async () => true),
}));

vi.mock("@/lib/recordCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/recordCache")>()),
  cacheGetMeta,
  cacheListTable,
  getOfflinePins,
}));

vi.mock("@/lib/offlineFiles", () => ({
  cacheWorkspaceFilesForOffline,
  clearOfflineWorkspaceFileCache: vi.fn(async () => undefined),
  hasCachedWorkspaceFiles,
}));

import {
  isPageOfflineReady,
  useStore,
  warmOfflineScope,
  warmPageOfflineFiles,
} from "@/lib/store";
import type { DbProperty, Page } from "@/lib/types";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedUser,
  TEST_USER,
} from "./components/storeTestUtils";

const DB_ID = "db-offline";
const ROW_KEY = "workspaces/ws/files/row.pdf";

function propertyRecord() {
  const property = makeProp(DB_ID, { id: "files", type: "files" });
  return { id: property.id, value: property } as { id: string; value: DbProperty };
}

function rowWithAttachment() {
  return makeRow(DB_ID, {
    id: "row-1",
    properties: { files: [{ name: "row.pdf", url: ROW_KEY }] },
  });
}

function seedDatabasePage() {
  seedUser();
  useStore.setState({
    pagesById: { [DB_ID]: makePage({ id: DB_ID, kind: "database" }) },
    databaseRowIdsByDb: { [DB_ID]: [] },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
  cacheWorkspaceFilesForOffline.mockResolvedValue(true);
  hasCachedWorkspaceFiles.mockResolvedValue(true);
  getOfflinePins.mockResolvedValue({});
});

describe("offline database attachment readiness", () => {
  it("requires a complete cached row set and includes its attachment keys", async () => {
    seedDatabasePage();
    const row = rowWithAttachment();
    cacheGetMeta.mockImplementation(async (_userId: string, key: string) => {
      if (key === `rowsKeys:${DB_ID}`) return [{ h: "base" }];
      if (key === `rows:${DB_ID}:base`) {
        return { hasMore: false, queryKey: "{}", rowIds: [row.id] };
      }
      return undefined;
    });
    cacheListTable.mockImplementation(async (_userId: string, table: string) => {
      if (table === `props:${DB_ID}`) return [propertyRecord()];
      if (table === `rowsdata:${DB_ID}:base`) return [{ id: row.id, value: row }];
      return [];
    });

    await expect(isPageOfflineReady(DB_ID)).resolves.toBe(true);
    const required = hasCachedWorkspaceFiles.mock.calls[0]?.[0] as Set<string>;
    expect([...required]).toContain(ROW_KEY);
  });

  it("rejects a partial cached row query instead of overstating readiness", async () => {
    seedDatabasePage();
    const row = rowWithAttachment();
    cacheGetMeta.mockImplementation(async (_userId: string, key: string) => {
      if (key === `rowsKeys:${DB_ID}`) return [{ h: "base" }];
      if (key === `rows:${DB_ID}:base`) {
        return { hasMore: true, queryKey: "{}", rowIds: [row.id] };
      }
      return undefined;
    });
    cacheListTable.mockImplementation(async (_userId: string, table: string) =>
      table === `props:${DB_ID}` ? [propertyRecord()] : [{ id: row.id, value: row }]
    );

    await expect(isPageOfflineReady(DB_ID)).resolves.toBe(false);
    expect(hasCachedWorkspaceFiles).not.toHaveBeenCalled();
  });

  it("rejects a cached query whose listed row record is missing", async () => {
    seedDatabasePage();
    cacheGetMeta.mockImplementation(async (_userId: string, key: string) => {
      if (key === `rowsKeys:${DB_ID}`) return [{ h: "base" }];
      if (key === `rows:${DB_ID}:base`) {
        return { hasMore: false, queryKey: "{}", rowIds: ["missing-row"] };
      }
      return undefined;
    });
    cacheListTable.mockImplementation(async (_userId: string, table: string) =>
      table === `props:${DB_ID}` ? [propertyRecord()] : []
    );

    await expect(isPageOfflineReady(DB_ID)).resolves.toBe(false);
  });
});

describe("offline warmer database attachment pass", () => {
  it("does not treat storage-looking prose as an attachment key", async () => {
    seedUser();
    const pageId = "page-prose";
    const attachmentKey = "workspaces/ws/files/actual.png";
    useStore.setState({
      pagesById: { [pageId]: makePage({ id: pageId }) },
      blocksByPage: {
        [pageId]: [
          {
            id: "prose",
            pageId,
            type: "paragraph",
            position: 0,
            content: {
              rich: [{ text: "workspaces/ws/files/not-an-attachment.txt" }],
              plainText: "/api/storage/files/workspaces/ws/files/not-an-attachment.txt",
            },
          },
          {
            id: "image",
            pageId,
            type: "image",
            position: 1,
            content: { url: attachmentKey },
          },
        ],
      },
    });

    await warmPageOfflineFiles(pageId);

    const warmed = cacheWorkspaceFilesForOffline.mock.calls[0]?.[0] as Set<string>;
    expect([...warmed]).toEqual([attachmentKey]);
  });

  it("collects attachments again after database rows load", async () => {
    seedDatabasePage();
    getOfflinePins.mockResolvedValue({ [DB_ID]: true });
    const row = rowWithAttachment();
    const loadDatabase = vi.fn(async () => {
      useStore.setState((state) => ({
        pagesById: { ...state.pagesById, [row.id]: row as Page },
        databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [DB_ID]: [row.id] },
      }));
    });
    useStore.setState({ loadDatabase });

    await warmOfflineScope(TEST_USER);

    expect(loadDatabase).toHaveBeenCalledWith(DB_ID, {});
    expect(cacheWorkspaceFilesForOffline).toHaveBeenCalledTimes(2);
    const secondPass = cacheWorkspaceFilesForOffline.mock.calls[1]?.[0] as Set<string>;
    expect([...secondPass]).toContain(ROW_KEY);
  });
});
