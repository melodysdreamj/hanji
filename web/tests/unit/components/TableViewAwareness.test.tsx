// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updatePageRemote: vi.fn(async () => undefined),
    updatePropertyRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
  };
});

import {
  databaseCellAwarenessId,
  TableView,
} from "@/components/database/TableView";
import type { PagePresenceAwareness } from "@/lib/pagePresence";
import type { DbView } from "@/lib/types";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedDbProps,
  seedPages,
  seedUser,
} from "./storeTestUtils";

const DB_ID = "db-awareness";
const ROW_ID = "row-awareness";
const TITLE_PROP_ID = "title";

function makeView(): DbView {
  return {
    id: "view-awareness",
    databaseId: DB_ID,
    name: "Table",
    type: "table",
    position: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      visibleProperties: [TITLE_PROP_ID],
    },
  };
}

function setupTable(extra?: Partial<ComponentProps<typeof TableView>>) {
  const db = makePage({ id: DB_ID, kind: "database", title: "Tasks" });
  const titleProp = makeProp(DB_ID, { id: TITLE_PROP_ID, type: "title", name: "Name" });
  const row = makeRow(DB_ID, { id: ROW_ID, title: "Task one" });
  seedPages([db, row]);
  seedDbProps(DB_ID, [titleProp]);
  return render(<TableView db={db} view={makeView()} rows={[row]} {...extra} />);
}

beforeEach(() => {
  resetStore();
  seedUser();
});

afterEach(cleanup);

describe("TableView cell awareness", () => {
  it("publishes database cell awareness when a text cell receives focus", () => {
    const publishAwareness = vi.fn();
    setupTable({ publishAwareness });

    const input = screen.getByDisplayValue("Task one") as HTMLInputElement;
    input.setSelectionRange(2, 5);
    fireEvent.focus(input);

    const id = databaseCellAwarenessId(ROW_ID, TITLE_PROP_ID);
    expect(publishAwareness).toHaveBeenCalledWith(id, "editing", [id], { start: 2, end: 5 });

    fireEvent.blur(input);
    expect(publishAwareness).toHaveBeenCalledWith(id, "idle", [], undefined);
  });

  it("renders a remote database cell awareness marker", () => {
    const id = databaseCellAwarenessId(ROW_ID, TITLE_PROP_ID);
    const remoteAwareness: PagePresenceAwareness = {
      color: "#337ea9",
      label: "owner@example.com",
      mode: "editing",
      selectedBlockIds: [id],
      updatedAt: Date.now(),
      userId: "remote-user",
    };

    const { container } = setupTable({
      remoteAwarenessByBlock: {
        [id]: [remoteAwareness],
      },
    });

    const cell = container.querySelector('[data-table-cell][data-remote-awareness="editing"]');
    expect(cell?.getAttribute("title")).toBe("owner@example.com editing");
    expect(screen.getByText("OW")).toBeTruthy();
  });
});
