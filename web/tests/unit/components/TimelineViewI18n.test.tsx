// @vitest-environment jsdom
//
// TimelineView chrome localization: EN strings stay byte-identical (several
// double as smoke selectors), ko locale renders Notion-style Korean.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/edgebase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/edgebase")>();
  return {
    ...actual,
    updatePageRemote: vi.fn(async () => undefined),
    updateDatabaseRowRemote: vi.fn(async () => undefined),
    updateViewRemote: vi.fn(async () => undefined),
    getDatabaseRowsRemote: vi.fn(async () => ({ rows: [] })),
  };
});

import { TimelineView } from "@/components/database/TimelineView";
import { useStore } from "@/lib/store";
import {
  makePage,
  makeProp,
  makeRow,
  resetStore,
  seedDbProps,
  seedPages,
  seedUser,
} from "./storeTestUtils";
import { makeView, seedDbViews } from "./editorTestUtils";

const DB_ID = "db-timeline";

function seedTimeline() {
  seedUser();
  seedPages([makePage({ id: DB_ID, kind: "database", title: "Tasks" })]);
  seedDbProps(DB_ID, [
    makeProp(DB_ID, { id: "title", type: "title", name: "Name", position: 0 }),
    makeProp(DB_ID, { id: "start", type: "date", name: "Start", position: 1 }),
  ]);
  const view = makeView(DB_ID, { id: "view-1", type: "timeline", name: "Timeline" });
  seedDbViews(DB_ID, [view]);
  const row = makeRow(DB_ID, {
    id: "row-1",
    title: "Dated task",
    properties: { start: "2026-07-10" },
  });
  seedPages([row]);
  useStore.setState((s) => ({
    databaseRowIdsByDb: { ...s.databaseRowIdsByDb, [DB_ID]: ["row-1"] },
    loadedDbs: new Set(s.loadedDbs).add(DB_ID),
  }));
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStore();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TimelineView i18n", () => {
  it("keeps the EN chrome strings the smokes select on", () => {
    const view = seedTimeline();
    render(
      <TimelineView db={useStore.getState().pagesById[DB_ID]} view={view} />
    );

    expect(screen.getByRole("group", { name: "Timeline zoom" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Today" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Dated task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: `New page in Tasks` })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Day" })).toBeTruthy();
  });

  it("renders Korean chrome for ko locale", () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    const view = seedTimeline();
    render(
      <TimelineView db={useStore.getState().pagesById[DB_ID]} view={view} />
    );

    expect(screen.getByRole("button", { name: "오늘" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Dated task 열기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "새 페이지 추가 (Tasks)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "일" })).toBeTruthy();
  });

  it("shows the localized empty state when no date property exists", () => {
    vi.stubGlobal("navigator", { language: "ko-KR" });
    seedUser();
    seedPages([makePage({ id: DB_ID, kind: "database", title: "Tasks" })]);
    seedDbProps(DB_ID, [
      makeProp(DB_ID, { id: "title", type: "title", name: "Name", position: 0 }),
    ]);
    const view = makeView(DB_ID, { id: "view-1", type: "timeline", name: "Timeline" });
    seedDbViews(DB_ID, [view]);

    render(
      <TimelineView db={useStore.getState().pagesById[DB_ID]} view={view} />
    );

    expect(screen.getByText("날짜 속성 추가")).toBeTruthy();
  });
});
