// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { i18next } from "@/i18n";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    createPropertyRemote: vi.fn(async (property) => property),
    updatePropertyRemote: vi.fn(async (_id, patch) => patch),
    updateDatabaseRowRemote: vi.fn(async (_id, patch) => patch),
    updateViewRemote: vi.fn(async (_id, patch) => patch),
  };
});

import { BoardView } from "@/components/database/BoardView";
import { useStore } from "@/lib/store";
import {
  makePage,
  makeProp,
  resetStore,
  seedDbProps,
  seedPages,
  seedUser,
} from "./storeTestUtils";
import { makeView, seedDbViews } from "./editorTestUtils";

const DB_ID = "db-board-i18n";

function seedBoard(withStatus = false) {
  seedUser();
  seedPages([makePage({ id: DB_ID, kind: "database", title: "Tasks" })]);
  seedDbProps(DB_ID, [
    makeProp(DB_ID, { id: "title", type: "title", name: "Name", position: 0 }),
    ...(withStatus
      ? [makeProp(DB_ID, {
          id: "status",
          type: "status",
          name: "상태",
          position: 1,
          config: { options: [{ id: "todo", name: "시작 전", color: "gray" }] },
        })]
      : []),
  ]);
  const view = makeView(DB_ID, {
    id: "view-board",
    type: "board",
    name: "Board",
    config: withStatus ? { groupBy: "status" } : {},
  });
  seedDbViews(DB_ID, [view]);
  useStore.setState((state) => ({
    databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [DB_ID]: [] },
    loadedDbs: new Set(state.loadedDbs).add(DB_ID),
  }));
  return view;
}

beforeEach(async () => {
  await i18next.changeLanguage("ko");
  vi.clearAllMocks();
  resetStore();
});

afterEach(async () => {
  cleanup();
  await i18next.changeLanguage("en");
});

describe("BoardView persistent generated names", () => {
  it("persists Korean status property and option names from the active catalog", async () => {
    const view = seedBoard();
    render(<BoardView db={useStore.getState().pagesById[DB_ID]} view={view} />);

    fireEvent.click(screen.getByRole("button", { name: "상태" }));

    await waitFor(() => {
      expect(useStore.getState().dbProperties(DB_ID)).toHaveLength(2);
    });
    const status = useStore.getState().dbProperties(DB_ID)[1];
    expect(status).toMatchObject({ name: "상태", type: "status" });
    expect(status.config?.options?.map((option) => option.name)).toEqual([
      "시작 전",
      "진행 중",
      "완료",
    ]);
    expect(useStore.getState().dbViews(DB_ID)[0].config?.groupBy).toBe(status.id);
  });

  it("persists Korean select property and option names from the active catalog", async () => {
    const view = seedBoard();
    render(<BoardView db={useStore.getState().pagesById[DB_ID]} view={view} />);

    fireEvent.click(screen.getByRole("button", { name: "선택" }));

    await waitFor(() => {
      expect(useStore.getState().dbProperties(DB_ID)).toHaveLength(2);
    });
    const select = useStore.getState().dbProperties(DB_ID)[1];
    expect(select).toMatchObject({ name: "선택", type: "select" });
    expect(select.config?.options?.map((option) => option.name)).toEqual(["옵션 1", "옵션 2"]);
  });

  it("persists the Korean untitled fallback when a group name is cleared", async () => {
    const view = seedBoard(true);
    render(<BoardView db={useStore.getState().pagesById[DB_ID]} view={view} />);

    fireEvent.click(screen.getByRole("button", { name: "시작 전 그룹 옵션" }));
    const input = await screen.findByLabelText("그룹 이름");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(useStore.getState().dbProperties(DB_ID)[1].config?.options?.[0]?.name)
        .toBe("제목 없음");
    });
  });

  it("moves focused cards and groups with the documented Alt+Arrow keyboard alternatives", async () => {
    await i18next.changeLanguage("en");
    const view = seedBoard(true);
    const current = useStore.getState().dbProperties(DB_ID);
    const status = current.find((prop) => prop.id === "status")!;
    seedDbProps(DB_ID, [
      ...current.filter((prop) => prop.id !== status.id),
      { ...status, config: {
        ...status.config,
        options: [
          { id: "todo", name: "Todo", color: "gray" },
          { id: "doing", name: "Doing", color: "blue" },
        ],
      } },
    ]);
    const row = makePage({
      id: "board-keyboard-row",
      kind: "page",
      parentId: DB_ID,
      parentType: "database",
      title: "Keyboard task",
      properties: { status: "todo" },
    });
    seedPages([row]);
    useStore.setState((state) => ({
      databaseRowIdsByDb: { ...state.databaseRowIdsByDb, [DB_ID]: [row.id] },
    }));
    render(<BoardView db={useStore.getState().pagesById[DB_ID]} view={view} />);

    const card = screen.getByRole("button", { name: "Open Keyboard task in Todo" });
    fireEvent.keyDown(card, { key: "ArrowRight", altKey: true });
    expect(useStore.getState().pagesById[row.id].properties?.status).toBe("doing");
    expect(screen.getByRole("status").textContent).toContain("Moved Keyboard task to Doing");

    const todoGroup = screen.getByRole("button", { name: "Todo group options" });
    fireEvent.keyDown(todoGroup, { key: "ArrowRight", altKey: true });
    expect(
      useStore.getState().dbProperties(DB_ID).find((prop) => prop.id === "status")?.config?.options?.map((option) => option.id)
    ).toEqual(["doing", "todo"]);
  });
});
