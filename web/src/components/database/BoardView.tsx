"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { useTranslation } from "react-i18next";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { openPageInNewTab, pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { persistentGeneratedLabels } from "@/lib/persistentGeneratedLabels";
import type { DbView, FilterGroup, Page, SelectOption, ViewFilter } from "@/lib/types";
import { useStore } from "@/lib/store";
import { newId } from "@/lib/ids";
import {
  applyView,
  applyViewFilterSeeds,
  effectiveFilterGroup,
  viewFilterSeedValues,
  visibleViewProperties,
} from "./query";
import { cardCoverValue, coverBackground, hasCardPreview } from "./cardPreview";
import { COLOR_NAMES, chipStyle, nextColor } from "./colors";
import { NotionSelect } from "./NotionSelect";
import { localizedPropertyTypeLabel } from "./propertyTypes";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { PropValue } from "./PropValue";
import { useRowContextMenu, type RowOpenMode } from "./useRowContextMenu";
import { Plus } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import styles from "./database.module.css";
import subStyles from "./boardSubgroup.module.css";

const BOARD_CARD_DRAG = "application/x-hanji-board-card";
const BOARD_GROUP_DRAG = "application/x-hanji-board-group";

function optionIdsForFilterValues(propOptions: SelectOption[], value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  const allowed = new Set<string>();
  for (const item of values) {
    const raw = String(item ?? "").trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    for (const option of propOptions) {
      if (option.id.toLowerCase() === lower || option.name.toLowerCase() === lower) {
        allowed.add(option.id);
      }
    }
  }
  return allowed;
}

// Reorder the FULL group-option list so `sourceId` lands immediately before
// `targetId`. A filtered board only renders a subset of the options, but every
// group mutation writes the WHOLE option list back to the property — deriving
// the new list from the visible subset silently deletes the filtered-out
// options (permanent data loss). Operating by id on the full list keeps hidden
// options intact. Returns null for a no-op or when an id is missing.
export function reorderGroupOptionsById(
  full: SelectOption[],
  sourceId: string,
  targetId: string
): SelectOption[] | null {
  if (!sourceId || sourceId === targetId) return null;
  const next = full.slice();
  const sourceIndex = next.findIndex((opt) => opt.id === sourceId);
  if (sourceIndex < 0) return null;
  const [source] = next.splice(sourceIndex, 1);
  // Re-find the target AFTER removing the source, else a rightward move lands
  // one slot past the target (stale index).
  const targetIndex = next.findIndex((opt) => opt.id === targetId);
  if (targetIndex < 0) return null;
  next.splice(targetIndex, 0, source);
  return next;
}

function collectAllowedGroupIdsFromFilter(
  filter: ViewFilter,
  groupPropId: string,
  propOptions: SelectOption[]
) {
  if (filter.propertyId !== groupPropId) return null;
  if (filter.operator !== "equals" && filter.operator !== "contains") return null;
  const ids = optionIdsForFilterValues(propOptions, filter.value);
  return ids.size > 0 ? ids : null;
}

function intersectAllowedGroupIds(current: Set<string> | null, next: Set<string>) {
  if (!current) return new Set<string>(next);
  const out = new Set<string>();
  current.forEach((id) => {
    if (next.has(id)) out.add(id);
  });
  return out;
}

function collectAllowedGroupIdsFromGroup(
  group: FilterGroup,
  groupPropId: string,
  propOptions: SelectOption[]
) {
  if (group.conjunction !== "and") return null;
  const collected: Set<string>[] = [];
  for (const filter of group.filters ?? []) {
    const ids = collectAllowedGroupIdsFromFilter(filter, groupPropId, propOptions);
    if (ids) collected.push(ids);
  }
  for (const child of group.groups ?? []) {
    const ids = collectAllowedGroupIdsFromGroup(child, groupPropId, propOptions);
    if (ids) collected.push(ids);
  }
  if (collected.length === 0) return null;
  let allowed: Set<string> | null = null;
  for (const ids of collected) {
    allowed = intersectAllowedGroupIds(allowed, ids);
  }
  if (!allowed || allowed.size === 0) return null;
  return allowed;
}

function isImportedNotionCancelOption(option: SelectOption) {
  const name = option.name.trim().toLowerCase();
  return name === "취소" || name === "cancel" || name === "canceled" || name === "cancelled";
}

function includeImportedNotionTerminalVisibleGroups(
  view: DbView,
  allowed: Set<string>,
  propOptions: SelectOption[]
) {
  if (typeof view.config?.notionViewId !== "string") return allowed;
  const next = new Set(allowed);
  for (const option of propOptions) {
    if (isImportedNotionCancelOption(option)) next.add(option.id);
  }
  return next;
}

function filteredBoardGroupOptions(view: DbView, groupPropId: string, propOptions: SelectOption[]) {
  const filterGroup = effectiveFilterGroup(view.config);
  const groupFilter = filterGroup
    ? collectAllowedGroupIdsFromGroup(filterGroup, groupPropId, propOptions)
    : null;
  return groupFilter ? includeImportedNotionTerminalVisibleGroups(view, groupFilter, propOptions) : null;
}

export function BoardView({
  db,
  view,
  rows: rowsProp,
  readOnly = false,
  search,
  contextPageId,
  onEditRowProperties,
  onOpenRow,
  onOpenRowIn,
}: {
  db: Page;
  view: DbView;
  rows?: Page[];
  readOnly?: boolean;
  search?: string;
  contextPageId?: string;
  onEditRowProperties?: (pageId: string) => void;
  onOpenRow?: (pageId: string) => void;
  onOpenRowIn?: (pageId: string, mode: RowOpenMode) => void;
}) {
  const { t } = useTranslation(["boardView", "common"]);
  const generatedLabels = persistentGeneratedLabels(t);
  const router = useRouter();
  const props = useStore(useShallow((s) => s.dbProperties(db.id)));
  const storeRows = useStore(useShallow((s) => s.dbRows(db.id)));
  const rows = rowsProp ?? storeRows;
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const addRow = useStore((s) => s.addRow);
  const addProperty = useStore((s) => s.addProperty);
  const updateProperty = useStore((s) => s.updateProperty);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const moveDatabaseRow = useStore((s) => s.moveDatabaseRow);
  const updateView = useStore((s) => s.updateView);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverGroup, setDragOverGroup] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ group: string; index: number } | null>(null);
  const [groupMenuId, setGroupMenuId] = useState<string | null>(null);
  const [groupNameDraft, setGroupNameDraft] = useState("");
  const [groupMenuPos, setGroupMenuPos] = useState<{ top: number; left: number } | null>(null);
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const groupMenuReturnRef = useRef<HTMLButtonElement | null>(null);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const groupMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const addGroupButtonRef = useRef<HTMLButtonElement>(null);
  const { openRowContextMenu, openRowContextMenuFromElement, rowContextMenu } =
    useRowContextMenu({
      onEditProperties: onEditRowProperties,
      onOpenRowIn,
    });

  const groupProp =
    props.find((p) => p.id === view.config?.groupBy) ??
    props.find((p) => p.type === "select" || p.type === "status");

  // Memoized like TableView's `shown`: applyView runs a full search-filter +
  // filter-group + multi-key sort over every loaded row, and board renders on
  // high-frequency drag-over/hover state changes.
  const shown = useMemo(
    () => applyView(rows, props, view, pagesById, { search, currentPageId: contextPageId }),
    [rows, props, view, pagesById, search, contextPageId]
  );
  const cardProps = visibleViewProperties(props, view).filter(
    (p) => p.type !== "title" && p.id !== groupProp?.id
  );
  const cardSize = view.config?.cardSize ?? "medium";
  const isImportedNotionView = typeof view.config?.notionViewId === "string";
  const showPreview = !!view.config?.coverProperty && hasCardPreview(view.config.coverProperty);
  const wrap = !!view.config?.wrap;
  const fitImage = !!view.config?.fitImage;
  const dbTitle = pageDisplayTitle(db);

  function closeGroupMenu(restoreFocus = false) {
    setGroupMenuId(null);
    setGroupMenuPos(null);
    groupMenuTriggerRef.current = null;
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        if (groupMenuReturnRef.current?.isConnected) {
          groupMenuReturnRef.current.focus();
        } else {
          addGroupButtonRef.current?.focus();
        }
        groupMenuReturnRef.current = null;
      });
    }
  }

  // Portal + clamp the group menu so it isn't clipped by the board's
  // overflow-x scroll container (mirrors AddPropertyButton in TableView).
  useLayoutEffect(() => {
    if (!groupMenuId) return;
    function place() {
      const r = groupMenuTriggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const MENU_WIDTH = 260;
      const MARGIN = 8;
      const left = Math.min(
        Math.max(MARGIN, r.left),
        window.innerWidth - MENU_WIDTH - MARGIN
      );
      setGroupMenuPos({ top: r.bottom + 4, left });
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [groupMenuId]);

  async function createGroupProperty(type: "select" | "status") {
    if (readOnly) return;
    const prop = await addProperty(
      db.id,
      type,
      type === "status"
        ? generatedLabels.propertyNames.status
        : generatedLabels.propertyNames.select,
      {
        options:
          type === "status"
            ? [
                { id: "todo", name: generatedLabels.statusOptions.todo, color: "gray" },
                { id: "doing", name: generatedLabels.statusOptions.doing, color: "blue" },
                { id: "done", name: generatedLabels.statusOptions.done, color: "green" },
              ]
            : [
                { id: "option-1", name: generatedLabels.selectOptions.first, color: "gray" },
                { id: "option-2", name: generatedLabels.selectOptions.second, color: "blue" },
              ],
      }
    );
    if (!prop) return;
    updateView(view.id, { config: { ...view.config, groupBy: prop.id } });
  }

  if (!groupProp) {
    return (
      <div className={styles.boardEmpty}>
        <div className={styles.viewEmptyTitle}>{t("boardView:groupThisBoard")}</div>
        <div className={styles.viewEmptyDesc}>{t("boardView:groupThisBoardDesc")}</div>
        {!readOnly && (
          <div className={styles.boardEmptyActions}>
            <button type="button" onClick={() => void createGroupProperty("status")}>
              <Plus size={14} aria-hidden="true" />
              {localizedPropertyTypeLabel("status")}
            </button>
            <button type="button" onClick={() => void createGroupProperty("select")}>
              <Plus size={14} aria-hidden="true" />
              {localizedPropertyTypeLabel("select")}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Second-level grouping: split each column's cards into labeled sub-sections
  // by another select/status property. Self-contained to BoardView.
  const subGroupableProps = props.filter(
    (p) => (p.type === "select" || p.type === "status") && p.id !== groupProp.id
  );
  const subGroupProp =
    view.config?.subGroupBy
      ? subGroupableProps.find((p) => p.id === view.config?.subGroupBy) ?? null
      : null;
  const subGroupPropertyOptions = [
    { value: "", label: t("boardView:none") },
    ...subGroupableProps.map((prop) => ({
      value: prop.id,
      label: prop.name || generatedLabels.untitled,
      icon: <PropertyTypeIcon type={prop.type} size={14} />,
    })),
  ];
  const subGroupOptions = subGroupProp?.config?.options ?? [];
  // Stable rank for a row's sub-group value: option order, then "No value" last.
  const subRank = (row: Page) => {
    if (!subGroupProp) return 0;
    const v = row.properties?.[subGroupProp.id];
    const id = Array.isArray(v) ? v[0] : v;
    if (id == null || id === "") return subGroupOptions.length;
    const idx = subGroupOptions.findIndex((o) => o.id === id);
    return idx < 0 ? subGroupOptions.length : idx;
  };
  // The sub-group option id a row belongs to ("__none" for no value).
  const subKeyOf = (row: Page) => {
    if (!subGroupProp) return "__none";
    const v = row.properties?.[subGroupProp.id];
    const id = Array.isArray(v) ? v[0] : v;
    if (id == null || id === "") return "__none";
    return subGroupOptions.some((o) => o.id === id) ? String(id) : "__none";
  };

  const allGroupOptions = groupProp.config?.options ?? [];
  const groupPropertyName = groupProp.name || generatedLabels.untitled;
  const subGroupPropertyName = subGroupProp?.name || generatedLabels.untitled;
  const allowedGroupIds = filteredBoardGroupOptions(view, groupProp.id, allGroupOptions);
  const groupOptions = allowedGroupIds
    ? allGroupOptions.filter((option) => allowedGroupIds.has(option.id))
    : allGroupOptions;
  // For a status property, every row belongs to a group: ungrouped rows fall
  // into the first option rather than a "No value" bucket (Notion semantics).
  const statusDefault =
    groupProp.type === "status" && groupOptions.length > 0 ? groupOptions[0] : null;
  // Rows whose group value references an option that no longer exists (a
  // deleted/renamed select option, or stale imported data) would otherwise
  // match NO column and NOT the "No value" bucket (their id is non-empty), so
  // they silently vanished from the board. Surface them in fallback columns
  // keyed by the stale id — mirroring TableView's `unknown:${value}` group — so
  // they stay visible and movable.
  const knownGroupIds = new Set(allGroupOptions.map((option) => option.id));
  const unknownGroupOptions: SelectOption[] = Array.from(
    new Set(
      shown
        .map((row) => {
          const v = row.properties?.[groupProp.id];
          return Array.isArray(v) ? v[0] : v;
        })
        .filter((id): id is string => typeof id === "string" && id !== "" && !knownGroupIds.has(id))
    )
  ).map((id) => ({ id, name: id, color: "default" }));
  const options: (SelectOption | null)[] = statusDefault
    ? [...groupOptions, ...unknownGroupOptions]
    : allowedGroupIds
      ? [...groupOptions, ...unknownGroupOptions]
    : [...groupOptions, ...unknownGroupOptions, null];
  const groupKey = (opt: SelectOption | null) => opt?.id ?? "__none";
  // Translate group chrome for ALL views, not just Notion-imported ones — the
  // dictionary is the single source, so native views localize too.
  const groupLabel = (opt: SelectOption | null) =>
    opt?.name ?? t("boardView:noValue", { groupName: groupPropertyName });
  const newGroupText = t("boardView:newGroup");
  const newGroupLabel = t("boardView:newGroupIn", { dbTitle, groupName: groupPropertyName });

  // One bucketing pass over `shown` instead of a full shown.filter per column
  // (O(rows) instead of O(rows × columns) per render). Ungrouped rows land in
  // the status-default column when one exists — same predicate the old
  // per-column filter used — and shown order is preserved within each bucket.
  const rowsByGroup = new Map<string, Page[]>();
  for (const r of shown) {
    const v = r.properties?.[groupProp.id];
    const id = Array.isArray(v) ? v[0] : v;
    const key = !id ? statusDefault?.id ?? "__none" : String(id);
    const bucket = rowsByGroup.get(key);
    if (bucket) bucket.push(r);
    else rowsByGroup.set(key, [r]);
  }
  const rowsFor = (opt: SelectOption | null) => rowsByGroup.get(groupKey(opt)) ?? [];

  // Rows for a column, ordered for rendering. When sub-grouping is active the
  // rows are stable-sorted by sub-group rank (option order, then "No value"
  // last) while preserving position order within each sub-group. When it is
  // unset this returns rowsFor(opt) untouched, so behavior is byte-identical.
  const colRowsFor = (opt: SelectOption | null) => {
    const base = rowsFor(opt);
    if (!subGroupProp) return base;
    return base
      .map((row, i) => ({ row, i }))
      .sort((a, b) => subRank(a.row) - subRank(b.row) || a.i - b.i)
      .map((e) => e.row);
  };

  async function addCardTo(opt: SelectOption | null) {
    if (readOnly) return;
    const row = await addRow(db.id, true, undefined, { focusTitle: true });
    applyViewFilterSeeds(
      row.id,
      viewFilterSeedValues(props, view, [groupProp!.id], { currentPageId: contextPageId }),
      updatePage,
      setRowProperty
    );
    // For status group-by, ungrouped cards land in the default (first) option,
    // so seed that value when no explicit group was given (#89).
    const groupOpt = opt ?? statusDefault;
    if (groupOpt) setRowProperty(row.id, groupProp!.id, groupOpt.id, { debounce: false });
    openRow(row.id);
  }

  function openRow(pageId: string) {
    if (onOpenRow) {
      onOpenRow(pageId);
    } else {
      router.push(pageHref(pageId));
    }
  }

  function openRowClick(pageId: string, e: React.MouseEvent<HTMLElement>) {
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  function openRowKey(pageId: string, e: ReactKeyboardEvent<HTMLElement>) {
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      e.stopPropagation();
      openRowContextMenuFromElement(pageId, e.currentTarget);
      return;
    }
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) openPageInNewTab(pageId);
    else openRow(pageId);
  }

  function clearCardDrag() {
    setDraggingId(null);
    setDragOverGroup(null);
    setDropTarget(null);
  }

  // Drop a card into a column at a given insertion index. Updates the group
  // value when moving across columns and the row position to reorder (#70).
  function dropCardInto(opt: SelectOption | null, index: number | null) {
    if (readOnly) return clearCardDrag();
    const id = draggingId;
    if (!id) return;
    const targetGroupId = opt?.id ?? (statusDefault ? statusDefault.id : null);
    const cur = shown.find((r) => r.id === id);
    const curGroup = (() => {
      const v = cur?.properties?.[groupProp!.id];
      const raw = Array.isArray(v) ? v[0] : v;
      return raw ?? (statusDefault ? statusDefault.id : null);
    })();
    if (curGroup !== targetGroupId) {
      setRowProperty(id, groupProp!.id, opt?.id ?? null, { debounce: false });
    }
    if (index != null) {
      // The drop index was computed against the full column (which may include
      // the dragged card). Re-derive neighbours from the same ordered list the
      // render uses (sub-group sorted when active), without the dragged card,
      // adjusting for its removal when it sat above the target.
      const fullRows = colRowsFor(opt);
      const fromIndex = fullRows.findIndex((r) => r.id === id);
      const adjusted = fromIndex >= 0 && fromIndex < index ? index - 1 : index;
      const colRows = fullRows.filter((r) => r.id !== id);
      const prev = colRows[adjusted - 1];
      const next = colRows[adjusted];
      // When sub-grouping is active, dropping a card between two cards of a
      // different sub-section should move it into that sub-section. Derive the
      // target sub-group from the drop neighbours so the card stays put; if the
      // neighbours disagree (a boundary), defer to the following card, falling
      // back to the preceding one at the very end of the column.
      if (subGroupProp && curGroup === targetGroupId) {
        const before = prev;
        const after = next;
        const targetSubKey =
          after != null ? subKeyOf(after) : before != null ? subKeyOf(before) : null;
        if (targetSubKey != null && targetSubKey !== subKeyOf(cur!)) {
          setRowProperty(id, subGroupProp.id, targetSubKey === "__none" ? null : targetSubKey, {
            debounce: false,
          });
        }
      }
      if (next) void moveDatabaseRow(id, next.id, "before");
      else if (prev) void moveDatabaseRow(id, prev.id, "after");
    }
    clearCardDrag();
  }

  function updateGroupOptions(next: SelectOption[]) {
    if (readOnly) return;
    updateProperty(groupProp!.id, { config: { ...groupProp!.config, options: next } });
  }

  function reorderGroup(sourceId: string, targetId: string) {
    if (readOnly) return;
    // Reorder within the FULL option list (allGroupOptions), not the filtered
    // visible subset, so hidden options survive a filtered-board reorder.
    const next = reorderGroupOptionsById(allGroupOptions, sourceId, targetId);
    if (!next) return;
    updateGroupOptions(next);
    setDraggingGroupId(null);
    setDragOverColumnId(null);
  }

  function moveGroupByKeyboard(sourceId: string, direction: -1 | 1) {
    if (readOnly) return;
    const sourceIndex = allGroupOptions.findIndex((option) => option.id === sourceId);
    const targetIndex = sourceIndex + direction;
    if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= allGroupOptions.length) return;
    const next = allGroupOptions.slice();
    [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
    updateGroupOptions(next);
    setMoveAnnouncement(
      t("boardView:groupMoved", {
        groupName: next[targetIndex]?.name,
        position: targetIndex + 1,
      })
    );
  }

  function moveCardByKeyboard(
    row: Page,
    opt: SelectOption | null,
    index: number,
    event: ReactKeyboardEvent<HTMLElement>
  ) {
    if (readOnly || row.isLocked || !event.altKey || event.metaKey || event.ctrlKey) return false;
    if (event.key === "ArrowUp" && index > 0) {
      event.preventDefault();
      void moveDatabaseRow(row.id, colRowsFor(opt)[index - 1].id, "before");
    } else if (event.key === "ArrowDown" && index < colRowsFor(opt).length - 1) {
      event.preventDefault();
      void moveDatabaseRow(row.id, colRowsFor(opt)[index + 1].id, "after");
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const currentGroupIndex = options.findIndex((candidate) => groupKey(candidate) === groupKey(opt));
      const nextGroupIndex = currentGroupIndex + (event.key === "ArrowRight" ? 1 : -1);
      const target = options[nextGroupIndex];
      if (currentGroupIndex < 0 || target === undefined) return false;
      event.preventDefault();
      setRowProperty(row.id, groupProp!.id, target?.id ?? null, { debounce: false });
      const targetRows = colRowsFor(target).filter((candidate) => candidate.id !== row.id);
      const last = targetRows.at(-1);
      if (last) void moveDatabaseRow(row.id, last.id, "after");
      setMoveAnnouncement(
        t("boardView:cardMovedToGroup", {
          title: pageDisplayTitle(row),
          groupName: groupLabel(target),
        })
      );
      return true;
    } else {
      return false;
    }
    setMoveAnnouncement(
      t("boardView:cardMovedWithinGroup", {
        title: pageDisplayTitle(row),
        groupName: groupLabel(opt),
        position: index + (event.key === "ArrowDown" ? 2 : 0),
      })
    );
    return true;
  }

  function patchGroupOption(id: string, patch: Partial<SelectOption>) {
    if (readOnly) return;
    // Patch by id across the FULL option list; mapping over the visible subset
    // would drop the filtered-out options when written back.
    updateGroupOptions(allGroupOptions.map((opt) => (opt.id === id ? { ...opt, ...patch } : opt)));
  }

  function openGroupMenu(opt: SelectOption, trigger?: HTMLButtonElement | null) {
    if (readOnly) return;
    groupMenuReturnRef.current = trigger ?? null;
    groupMenuTriggerRef.current = trigger ?? null;
    setGroupMenuId(opt.id);
    setGroupNameDraft(opt.name);
  }

  function commitGroupName(id: string) {
    if (readOnly) return;
    const name = groupNameDraft.trim() || generatedLabels.untitled;
    patchGroupOption(id, { name });
    setGroupNameDraft(name);
  }

  function addGroup() {
    if (readOnly) return;
    const opt: SelectOption = {
      id: newId(),
      name: newGroupText,
      color: nextColor(allGroupOptions.length),
    };
    // Append to the FULL option list so a filtered board doesn't drop the
    // hidden options when the new group is written back.
    updateGroupOptions([...allGroupOptions, opt]);
    groupMenuReturnRef.current = addGroupButtonRef.current;
    groupMenuTriggerRef.current = addGroupButtonRef.current;
    setGroupMenuId(opt.id);
    setGroupNameDraft(opt.name);
  }

  function colorButtons(root: HTMLElement | null) {
    return Array.from(root?.querySelectorAll<HTMLButtonElement>("[data-board-color]") ?? []);
  }

  function groupMenuFocusables() {
    return Array.from(
      groupMenuRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onGroupMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeGroupMenu(true);
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = groupMenuFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      e.stopPropagation();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      e.stopPropagation();
      first.focus();
    }
  }

  function onColorGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = colorButtons(e.currentTarget);
    if (buttons.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const activeIndex = buttons.findIndex((button) => button === document.activeElement);
    let nextIndex = activeIndex >= 0 ? activeIndex : 0;
    if (e.key === "ArrowRight") {
      nextIndex = activeIndex >= 0 ? (activeIndex + 1) % buttons.length : 0;
    } else if (e.key === "ArrowLeft") {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : buttons.length - 1;
    } else if (e.key === "ArrowDown") {
      nextIndex = activeIndex >= 0 ? Math.min(activeIndex + 2, buttons.length - 1) : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = activeIndex >= 0 ? Math.max(activeIndex - 2, 0) : 0;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = buttons.length - 1;
    }
    buttons[nextIndex]?.focus();
  }

  // The sub-group selector lists select/status props except the main groupBy.
  // Shown only when there are 2+ groupable props total (i.e. at least one
  // besides the main groupBy).
  const showSubGroupControl =
    subGroupableProps.length >= 1 && (!!subGroupProp || typeof view.config?.notionViewId !== "string");

  const board = (
    <div
      className={styles.board}
      data-size={cardSize}
      data-imported-notion={isImportedNotionView ? "true" : undefined}
    >
      {shown.length === 0 && !isImportedNotionView && (
        <div className={styles.boardHint}>
          <div className={styles.viewEmptyTitle}>
            {rows.length === 0 ? t("boardView:emptyTitle") : t("boardView:noResultsTitle")}
          </div>
          <div className={styles.viewEmptyDesc}>
            {rows.length === 0 ? t("boardView:emptyDesc") : t("boardView:noResultsDesc")}
          </div>
        </div>
      )}
      {options.map((opt) => {
        const colRows = colRowsFor(opt);
        const key = groupKey(opt);
        return (
          <div
            key={key}
            className={styles.boardCol}
            data-drag-over={dragOverGroup === key ? "true" : undefined}
            data-column-drag-over={dragOverColumnId === key ? "true" : undefined}
            data-group-color={opt?.color}
            onDragOver={(e) => {
              if (readOnly) return;
              const types = Array.from(e.dataTransfer.types);
              if (opt && (draggingGroupId || types.includes(BOARD_GROUP_DRAG))) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverColumnId(key);
                return;
              }
              if (draggingId && !draggingGroupId && (types.includes(BOARD_CARD_DRAG) || types.length === 0)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverGroup(key);
                // Default to dropping at the end of the column unless a specific
                // card refines the index in its own onDragOver below.
                setDropTarget((cur) =>
                  cur && cur.group === key ? cur : { group: key, index: colRows.length }
                );
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              setDragOverGroup((cur) => (cur === key ? null : cur));
              setDragOverColumnId((cur) => (cur === key ? null : cur));
              setDropTarget((cur) => (cur?.group === key ? null : cur));
            }}
            onDrop={(e) => {
              if (readOnly) return;
              e.preventDefault();
              const sourceGroupId = e.dataTransfer.getData(BOARD_GROUP_DRAG) || draggingGroupId;
              if (opt && sourceGroupId) {
                reorderGroup(sourceGroupId, opt.id);
                return;
              }
              if (e.dataTransfer.getData(BOARD_CARD_DRAG) || draggingId) {
                const index = dropTarget?.group === key ? dropTarget.index : null;
                dropCardInto(opt, index);
              }
            }}
          >
            <div
              className={styles.boardColHead}
              draggable={!readOnly && !!opt}
              data-group-dragging={draggingGroupId === opt?.id ? "true" : undefined}
              onDragStart={(e) => {
                if (readOnly || !opt) return;
                const target = e.target as HTMLElement;
                if (target.closest("[data-no-group-drag]")) {
                  e.preventDefault();
                  return;
                }
                setDraggingGroupId(opt.id);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(BOARD_GROUP_DRAG, opt.id);
              }}
              onDragEnd={() => {
                setDraggingGroupId(null);
                setDragOverColumnId(null);
              }}
            >
              {opt ? (
                <>
                  {!readOnly && (
                    <span
                      className={styles.boardGroupGrip}
                      title={t("boardView:dragGroup")}
                      aria-hidden="true"
                    >
                      ⋮⋮
                    </span>
                  )}
                  <button
                    type="button"
                    className={styles.boardGroupBtn}
                    data-no-group-drag
                    aria-label={t("boardView:groupOptions", { groupName: opt.name })}
                    aria-haspopup="dialog"
                    aria-expanded={groupMenuId === opt.id}
                    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
                    onClick={(e) => openGroupMenu(opt, e.currentTarget)}
                    onKeyDown={(event) => {
                      if (!event.altKey || event.metaKey || event.ctrlKey) return;
                      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                      event.preventDefault();
                      moveGroupByKeyboard(opt.id, event.key === "ArrowRight" ? 1 : -1);
                    }}
                  >
                    <span className={styles.chip} style={chipStyle(opt.color)}>
                      {opt.name}
                    </span>
                  </button>
                </>
              ) : (
                <span className={styles.boardNoGroup}>
                  {t("boardView:noValue", { groupName: groupPropertyName })}
                </span>
              )}
              <span className={styles.boardCount}>{colRows.length}</span>
              {opt && !readOnly && (
                <>
                  <button
                    type="button"
                    className={styles.boardGroupMore}
                    data-no-group-drag
                    aria-label={t("boardView:groupActions", { groupName: opt.name })}
                    aria-haspopup="dialog"
                    aria-expanded={groupMenuId === opt.id}
                    onClick={(e) => openGroupMenu(opt, e.currentTarget)}
                  >
                    •••
                  </button>
                  {groupMenuId === opt.id &&
                    groupMenuPos &&
                    createPortal(
                    <>
                      <button
                        type="button"
                        className={styles.menuBackdrop}
                        onClick={() => closeGroupMenu(true)}
                        tabIndex={-1}
                        aria-label={t("boardView:closeGroupOptions")}
                      />
                      <div
                        ref={groupMenuRef}
                        className={styles.boardGroupMenu}
                        style={{ position: "fixed", top: groupMenuPos.top, left: groupMenuPos.left }}
                        role="dialog"
                        aria-label={t("boardView:groupOptions", { groupName: opt.name })}
                        onKeyDown={onGroupMenuKeyDown}
                      >
                        <label className={styles.boardGroupName}>
                          <span>{t("boardView:groupName")}</span>
                          <input
                            value={groupNameDraft}
                            autoFocus
                            onChange={(e) => setGroupNameDraft(e.target.value)}
                            onBlur={() => commitGroupName(opt.id)}
                            onKeyDown={(e) => {
                              if (isComposingKeyEvent(e)) return;
                              if (e.key === "Enter") {
                                e.preventDefault();
                                e.stopPropagation();
                                commitGroupName(opt.id);
                                closeGroupMenu(true);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                e.stopPropagation();
                                closeGroupMenu(true);
                              }
                            }}
                          />
                        </label>
                        <div className={styles.boardGroupLabel}>{t("boardView:color")}</div>
                        <div
                          className={styles.boardColorGrid}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={t("boardView:groupColor")}
                          onKeyDown={onColorGridKeyDown}
                        >
                          {COLOR_NAMES.filter((color) => color !== "default").map((color) => (
                            <button
                              key={color}
                              type="button"
                              role="radio"
                              aria-checked={opt.color === color}
                              data-board-color
                              data-active={opt.color === color ? "true" : undefined}
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => patchGroupOption(opt.id, { color })}
                            >
                              <span style={chipStyle(color)} />
                              {color}
                            </button>
                          ))}
                        </div>
                      </div>
                    </>,
                    document.body
                  )}
                </>
              )}
            </div>
            <div className={styles.boardCards}>
              {colRows.map((row, index) => {
                const cover = cardCoverValue(row, props, view.config?.coverProperty);
                const showIndicator =
                  !!draggingId &&
                  draggingId !== row.id &&
                  dropTarget?.group === key &&
                  dropTarget.index === index;
                // Insert a sub-section header before the first card of each
                // sub-group when sub-grouping is active.
                let subHeader = null;
                if (subGroupProp) {
                  const subKey = subKeyOf(row);
                  const prevKey = index > 0 ? subKeyOf(colRows[index - 1]) : null;
                  if (subKey !== prevKey) {
                    const subOpt =
                      subKey === "__none"
                        ? null
                        : subGroupOptions.find((o) => o.id === subKey) ?? null;
                    const count = colRows.filter((r) => subKeyOf(r) === subKey).length;
                    subHeader = (
                      <div className={subStyles.section}>
                        {subOpt ? (
                          <span className={styles.chip} style={chipStyle(subOpt.color)}>
                            {subOpt.name}
                          </span>
                        ) : (
                          <span className={subStyles.sectionNone}>
                            {t("boardView:noValue", { groupName: subGroupPropertyName })}
                          </span>
                        )}
                        <span className={subStyles.sectionCount}>{count}</span>
                      </div>
                    );
                  }
                }
                const title = pageDisplayTitle(row);
                return (
                  <div key={row.id} className={styles.boardCardSlot}>
                    {subHeader}
                    {showIndicator && <div className={styles.boardDropLine} aria-hidden="true" />}
                    <div
                      className={styles.card}
                      role="button"
                      tabIndex={0}
                      aria-label={t("boardView:openRowInGroup", {
                        title,
                        groupName: groupLabel(opt),
                      })}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight"
                      data-size={cardSize}
                      data-wrap={wrap ? "true" : undefined}
                      data-dragging={draggingId === row.id ? "true" : undefined}
                      draggable={!readOnly}
                      onDragStart={(e) => {
                        if (readOnly) {
                          e.preventDefault();
                          return;
                        }
                        setDraggingId(row.id);
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData(BOARD_CARD_DRAG, row.id);
                      }}
                      onDragOver={(e) => {
                        if (readOnly) return;
                        if (!draggingId || draggingGroupId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                        const rect = e.currentTarget.getBoundingClientRect();
                        const after = e.clientY > rect.top + rect.height / 2;
                        const next = index + (after ? 1 : 0);
                        setDragOverGroup(key);
                        setDropTarget((cur) =>
                          cur && cur.group === key && cur.index === next
                            ? cur
                            : { group: key, index: next }
                        );
                      }}
                      onDragEnd={() => {
                        clearCardDrag();
                      }}
                      onClick={(e) => openRowClick(row.id, e)}
                      onKeyDown={(e) => {
                        if (moveCardByKeyboard(row, opt, index, e)) return;
                        openRowKey(row.id, e);
                      }}
                      onAuxClick={(e) => {
                        if (e.button === 1) {
                          e.preventDefault();
                          openPageInNewTab(row.id);
                        }
                      }}
                      onContextMenu={(e) => openRowContextMenu(row.id, e)}
                    >
                      {showPreview && (
                        <div
                          className={styles.cardCover}
                          data-has-image={cover ? "true" : undefined}
                          data-fit-image={fitImage ? "true" : undefined}
                          style={{ backgroundImage: coverBackground(cover) }}
                        >
                          {!cover && (
                            <span className={styles.cardIcon}>
                              <PageIconGlyph page={row} size={22} />
                            </span>
                          )}
                        </div>
                      )}
                      <div className={styles.cardTitle}>{title}</div>
                      <div className={styles.cardMeta}>
                        {cardProps.map((p) => (
                          <PropValue key={p.id} row={row} prop={p} interactive={false} />
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!!draggingId &&
                dropTarget?.group === key &&
                dropTarget.index >= colRows.length && (
                  <div className={styles.boardDropLine} aria-hidden="true" />
              )}
              {!readOnly && (
                <button
                  type="button"
                  className={styles.boardAdd}
                  title={t("boardView:newPageInGroup", { groupName: groupLabel(opt), dbTitle })}
                  aria-label={t("boardView:newPageInGroup", { groupName: groupLabel(opt), dbTitle })}
                  onClick={() => void addCardTo(opt)}
                >
                  <Plus size={14} aria-hidden="true" />{" "}
                  {t("boardView:newPage")}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <button
          ref={addGroupButtonRef}
          type="button"
          className={styles.boardAddGroup}
          title={newGroupLabel}
          aria-label={newGroupLabel}
          onClick={addGroup}
        >
          <Plus size={15} aria-hidden="true" />
          {` ${newGroupText}`}
        </button>
      )}
      <div className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {moveAnnouncement}
      </div>
      {rowContextMenu}
    </div>
  );

  // When there is nothing to sub-group by, render the board exactly as before
  // so the unset path stays byte-identical.
  if (!showSubGroupControl) return board;

  return (
    <div className={subStyles.wrap}>
      <div className={subStyles.toolbar}>
        <span className={subStyles.toolbarLabel}>
          {t("boardView:subGroup")}
        </span>
        <NotionSelect
          className={subStyles.select}
          ariaLabel={t("boardView:boardSubGroupAria")}
          value={subGroupProp?.id ?? ""}
          options={subGroupPropertyOptions}
          disabled={readOnly}
          onChange={(value) => {
            if (readOnly) return;
            updateView(view.id, {
              config: { ...view.config, subGroupBy: value || undefined },
            });
          }}
        />
      </div>
      {board}
    </div>
  );
}
