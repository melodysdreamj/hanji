"use client";

import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { nextPropertyCopyName } from "@/lib/persistentGeneratedLabels";
import type { DbProperty, DbView, Page, PropertyConfig, PropertyType } from "@/lib/types";
import { useStore } from "@/lib/store";
import { pageHref } from "@/lib/navigation";
import { positionBetween } from "@/lib/ids";
import { CheckIcon, ChevronDown, ChevronUp, FileText, Plus, Search, Settings } from "../icons";
import { PropValue } from "./PropValue";
import { PropertyCell } from "./PropertyCell";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeConfig } from "./PropertyTypeConfig";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { usePropertyTypeChangeConfirm } from "./PropertyTypeChangeConfirm";
import { configForType, CREATABLE_PROPERTY_TYPES, PROPERTY_TYPES, propertyTypeLabel } from "./propertyTypes";
import { orderViewProperties } from "./query";
import styles from "./database.module.css";

const ROW_PROPERTY_DRAG = "application/x-hanji-row-property";
const DEFAULT_VISIBLE_ROW_PROPERTY_COUNT = 10;

const HIDE_WHEN_EMPTY_UNSUPPORTED = new Set<DbProperty["type"]>([
  "formula",
  "rollup",
  "unique_id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
]);

function canHideWhenEmpty(prop: DbProperty) {
  return !HIDE_WHEN_EMPTY_UNSUPPORTED.has(prop.type);
}

function isEmptyRowProperty(row: Page, prop: DbProperty) {
  if (prop.type === "title") return row.title.trim().length === 0;
  if (prop.type === "created_time") return !row.createdAt;
  if (prop.type === "last_edited_time") return !row.updatedAt;
  if (prop.type === "created_by") return !row.createdBy;
  if (prop.type === "last_edited_by") return !row.lastEditedBy;
  if (prop.type === "formula" || prop.type === "rollup") {
    const computed = row.__computed?.[prop.id]?.formatted;
    if (computed != null) return String(computed).trim().length === 0;
  }
  const value = row.properties?.[prop.id];
  if (value == null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "string") return value.trim().length === 0;
  return false;
}

function isHiddenRowProperty(row: Page, prop: DbProperty) {
  return (
    !!prop.config?.hideInPagePanel ||
    (canHideWhenEmpty(prop) && !!prop.config?.hideWhenEmpty && isEmptyRowProperty(row, prop))
  );
}

function orderPropertiesByIds(props: DbProperty[], order?: string[]) {
  if (!order || order.length === 0) return props;
  const map = new Map(props.map((prop) => [prop.id, prop]));
  const ordered: DbProperty[] = [];
  for (const id of order) {
    const prop = map.get(id);
    if (!prop) continue;
    ordered.push(prop);
    map.delete(id);
  }
  return [...ordered, ...map.values()];
}

function clonePropertyConfig(config?: PropertyConfig) {
  return config ? (JSON.parse(JSON.stringify(config)) as PropertyConfig) : undefined;
}

function isSystemProperty(prop: DbProperty) {
  return (
    prop.type === "created_time" ||
    prop.type === "last_edited_time" ||
    prop.type === "created_by" ||
    prop.type === "last_edited_by"
  );
}

export function orderRowPanelProperties(props: DbProperty[], view?: DbView) {
  const rowOrder = view?.config?.rowPagePropertyOrder;
  if (rowOrder && rowOrder.length > 0) return orderPropertiesByIds(props, rowOrder);
  return view ? orderViewProperties(props, view) : props;
}

export function RowProperties({
  dbId,
  row,
  view,
  openCustomizeTick = 0,
  readOnly = false,
  onOpenPage,
  pageHrefForRelation,
  relationNavigation = true,
  showBackReferences = true,
  showPropertyControls = true,
}: {
  dbId: string;
  row: Page;
  view?: DbView;
  openCustomizeTick?: number;
  readOnly?: boolean;
  onOpenPage?: (pageId: string) => void;
  pageHrefForRelation?: (pageId: string) => string;
  relationNavigation?: boolean;
  showBackReferences?: boolean;
  showPropertyControls?: boolean;
}) {
  const { t } = useTranslation(["rowProperties", "common"]);
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [customizeSearch, setCustomizeSearch] = useState("");
  const [propertyMenuId, setPropertyMenuId] = useState<string | null>(null);
  const [propertyMenuPlacement, setPropertyMenuPlacement] = useState<"above" | "below">("below");
  const [showHiddenPropertiesFor, setShowHiddenPropertiesFor] = useState<string | null>(null);
  const [draggingPropertyId, setDraggingPropertyId] = useState<string | null>(null);
  const [dragOverPropertyId, setDragOverPropertyId] = useState<string | null>(null);
  const [dragOverSide, setDragOverSide] = useState<"before" | "after">("before");
  const menuReturnRef = useRef<HTMLElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addSearchRef = useRef<HTMLInputElement>(null);
  const customizeMenuRef = useRef<HTMLDivElement>(null);
  const customizeSearchRef = useRef<HTMLInputElement>(null);

  const propertyMenuRef = useRef<HTMLDivElement>(null);
  const { confirmPropertyTypeChange, typeChangeConfirmDialog } = usePropertyTypeChangeConfirm();
  const loadDatabase = useStore((s) => s.loadDatabase);
  const addProperty = useStore((s) => s.addProperty);
  const updateProperty = useStore((s) => s.updateProperty);
  const updateView = useStore((s) => s.updateView);
  const deleteProperty = useStore((s) => s.deleteProperty);
  const notify = useStore((s) => s.notify);
  const props = useStore(useShallow((s) => s.dbProperties(dbId)));
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const propsByDb = useStore(useShallow((s) => s.propsByDb));
  const router = useRouter();
  const orderedProps = orderRowPanelProperties(props, view);
  const rowProps = orderedProps.filter((prop) => prop.type !== "title");
  const hiddenPropertiesKey = `${dbId}:${row.id}`;
  const showHiddenProperties = showHiddenPropertiesFor === hiddenPropertiesKey;
  const hiddenProps = rowProps.filter((prop) => isHiddenRowProperty(row, prop));
  const visibleProps = rowProps.filter((prop) => !isHiddenRowProperty(row, prop));
  const overflowProps =
    visibleProps.length > DEFAULT_VISIBLE_ROW_PROPERTY_COUNT
      ? visibleProps.slice(DEFAULT_VISIBLE_ROW_PROPERTY_COUNT)
      : [];
  const displayedProps = showHiddenProperties
    ? rowProps
    : visibleProps.slice(0, DEFAULT_VISIBLE_ROW_PROPERTY_COUNT);
  const hiddenCount = hiddenProps.length + overflowProps.length;
  const canOpenPropertyMenus = !readOnly;
  const canShowPropertyManagementControls = !readOnly && showPropertyControls;
  const showCustomizeMenuOnly = !canShowPropertyManagementControls && customizeOpen && canOpenPropertyMenus;
  const customizeSearchQuery = customizeSearch.trim().toLowerCase();
  const customizeSearchTerms = customizeSearchQuery.split(/\s+/).filter(Boolean);
  const filteredCustomizeProps = customizeSearchQuery
    ? rowProps.filter((prop) => {
        const haystack = `${prop.name} ${propertyTypeLabel(prop.type)} ${prop.description ?? ""}`
          .toLowerCase();
        return customizeSearchTerms.every((term) => haystack.includes(term));
      })
    : rowProps;
  const addSearchTerms = addSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const filteredAddTypes =
    addSearchTerms.length > 0
      ? CREATABLE_PROPERTY_TYPES.filter((type) => {
          const haystack = `${type.label} ${type.type}`.toLowerCase();
          return addSearchTerms.every((term) => haystack.includes(term));
        })
      : CREATABLE_PROPERTY_TYPES;
  const editablePropertyTypes = (currentType: PropertyType) =>
    PROPERTY_TYPES.filter(
      (type) =>
        type.type === currentType ||
        !["created_time", "last_edited_time", "created_by", "last_edited_by"].includes(type.type)
    ).map((type) => ({
      value: type.type,
      label: type.label,
      icon: <PropertyTypeIcon type={type.type} size={14} />,
    }));
  useEffect(() => {
    if (!openCustomizeTick || !canOpenPropertyMenus) return;
    setAddOpen(false);
    setPropertyMenuId(null);
    setCustomizeOpen(true);
    window.requestAnimationFrame(() => {
      customizeSearchRef.current?.focus({ preventScroll: true });
    });
  }, [canOpenPropertyMenus, openCustomizeTick]);

  function openPage(pageId: string) {
    if (onOpenPage) onOpenPage(pageId);
    else router.push(pageHref(pageId));
  }

  function onPageLinkClick(pageId: string, e: ReactMouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPage(pageId);
  }

  // Incoming relations: rows in any database whose relation property links here.
  const backReferences = useMemo(() => {
    const out: { page: Page; propName: string }[] = [];
    for (const page of Object.values(pagesById)) {
      if (page.id === row.id || page.inTrash) continue;
      if (page.parentType !== "database" || !page.parentId) continue;
      const relProps = (propsByDb[page.parentId] ?? []).filter((p) => p.type === "relation");
      for (const rp of relProps) {
        const value = page.properties?.[rp.id];
        const ids = Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
        if (ids.includes(row.id)) out.push({ page, propName: rp.name });
      }
    }
    return out;
  }, [pagesById, propsByDb, row.id]);

  useEffect(() => {
    void loadDatabase(dbId);
  }, [dbId, loadDatabase]);

  useEffect(() => {
    if (canOpenPropertyMenus) return;
    const frame = window.requestAnimationFrame(() => {
      setPropertyMenuId(null);
      menuReturnRef.current = null;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canOpenPropertyMenus]);

  useEffect(() => {
    if (canShowPropertyManagementControls) return;
    const frame = window.requestAnimationFrame(() => {
      setAddOpen(false);
      setAddSearch("");
      if (!openCustomizeTick) {
        setCustomizeOpen(false);
        setCustomizeSearch("");
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [canShowPropertyManagementControls, openCustomizeTick]);

  useEffect(() => {
    if (!addOpen) return;
    const frame = window.requestAnimationFrame(() => {
      addSearchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [addOpen]);

  useEffect(() => {
    if (!customizeOpen) return;
    const frame = window.requestAnimationFrame(() => {
      customizeSearchRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [customizeOpen]);

  async function createProperty(type: PropertyType, label: string) {
    if (!canShowPropertyManagementControls) return;
    try {
      const prop = await addProperty(dbId, type, label, configForType(type, undefined, dbId));
      if (!prop) {
        notify(t("rowProperties:createPropertyFailed"), "error");
        return;
      }
      notify(t("rowProperties:createdProperty", { name: prop.name }), "success");
      setAddOpen(false);
      setAddSearch("");
      window.requestAnimationFrame(() => addButtonRef.current?.focus());
    } catch {
      notify(t("rowProperties:createPropertyFailed"), "error");
    }
  }

  async function duplicatePropertyWithFeedback(prop: DbProperty) {
    if (!canOpenPropertyMenus || prop.type === "title" || isSystemProperty(prop)) return;
    try {
      const physical = [...props].sort((a, b) => a.position - b.position);
      const physicalIndex = physical.findIndex((item) => item.id === prop.id);
      const nextPhysical = physical[physicalIndex + 1];
      const duplicate = await addProperty(
        prop.databaseId,
        prop.type,
        nextPropertyCopyName(props, prop.name, t),
        clonePropertyConfig(prop.config)
      );
      if (!duplicate) {
        notify(t("rowProperties:duplicatePropertyFailed"), "error");
        return;
      }
      const position = positionBetween(prop.position, nextPhysical?.position);
      updateProperty(duplicate.id, { description: prop.description, position });

      if (view) {
        const currentOrder = view.config?.rowPagePropertyOrder ?? rowProps.map((item) => item.id);
        const sourceIndex = currentOrder.indexOf(prop.id);
        const withoutDuplicate = currentOrder.filter((id) => id !== duplicate.id);
        const rowPagePropertyOrder =
          sourceIndex >= 0
            ? [
                ...withoutDuplicate.slice(0, sourceIndex + 1),
                duplicate.id,
                ...withoutDuplicate.slice(sourceIndex + 1),
              ]
            : [...withoutDuplicate, duplicate.id];
        updateView(view.id, {
          config: {
            ...view.config,
            rowPagePropertyOrder,
          },
        });
      }

      notify(t("rowProperties:duplicatedProperty"), "success");
      setPropertyMenuId(null);
      window.requestAnimationFrame(() => menuReturnRef.current?.focus());
    } catch {
      notify(t("rowProperties:duplicatePropertyFailed"), "error");
    }
  }

  async function deletePropertyWithFeedback(prop: DbProperty) {
    if (!canOpenPropertyMenus) return;
    if (!window.confirm(t("rowProperties:confirmDeleteProperty", { name: prop.name }))) return;
    try {
      const deleted = await deleteProperty(prop.id);
      if (!deleted) {
        notify(t("rowProperties:deletePropertyFailed"), "error");
        return;
      }
      notify(t("rowProperties:deletedProperty"), "success");
      setPropertyMenuId(null);
      window.requestAnimationFrame(() => menuReturnRef.current?.focus());
    } catch {
      notify(t("rowProperties:deletePropertyFailed"), "error");
    }
  }

  function closeMenus(restoreFocus = false) {
    setAddOpen(false);
    setCustomizeOpen(false);
    setPropertyMenuId(null);
    setAddSearch("");
    setCustomizeSearch("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        menuReturnRef.current?.focus();
        menuReturnRef.current = null;
      });
    }
  }

  function menuItems(root: HTMLDivElement | null) {
    return Array.from(root?.querySelectorAll<HTMLButtonElement>("[data-row-menu-item]") ?? [])
      .filter((item) => !item.disabled && item.offsetParent !== null);
  }

  function menuFocusables(root: HTMLDivElement | null) {
    return Array.from(
      root?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>, root: HTMLDivElement | null) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenus(true);
      return;
    }
    if (e.key === "Tab") {
      const focusables = menuFocusables(root);
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
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    // Let native form controls (the Name input, Type select) keep their own
    // arrow-key behavior instead of stealing it for menu-item navigation.
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    const items = menuItems(root);
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const activeIndex = items.findIndex((item) => item === document.activeElement);
    let nextIndex = activeIndex >= 0 ? activeIndex : 0;

    if (e.key === "ArrowDown") {
      nextIndex = activeIndex >= 0 ? (activeIndex + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = activeIndex > 0 ? activeIndex - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }
    items[nextIndex]?.focus();
  }

  function propertyDropSide(e: ReactDragEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function clearPropertyDrag() {
    setDraggingPropertyId(null);
    setDragOverPropertyId(null);
    setDragOverSide("before");
  }

  function reorderProperty(sourceId: string, targetId: string, side: "before" | "after") {
    if (!canOpenPropertyMenus || !sourceId || sourceId === targetId) return;
    const next = rowProps.slice();
    const sourceIndex = next.findIndex((prop) => prop.id === sourceId);
    const targetIndex = next.findIndex((prop) => prop.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [source] = next.splice(sourceIndex, 1);
    const insertionIndex = next.findIndex((prop) => prop.id === targetId);
    next.splice(insertionIndex + (side === "after" ? 1 : 0), 0, source);
    const finalIndex = next.findIndex((prop) => prop.id === sourceId);
    if (view) {
      const knownIds = new Set(next.map((prop) => prop.id));
      const remainingIds = props
        .filter((prop) => prop.type !== "title" && !knownIds.has(prop.id))
        .map((prop) => prop.id);
      updateView(view.id, {
        config: {
          ...view.config,
          rowPagePropertyOrder: [...next.map((prop) => prop.id), ...remainingIds],
        },
      });
      return;
    }
    updateProperty(sourceId, {
      position: positionBetween(next[finalIndex - 1]?.position, next[finalIndex + 1]?.position),
    });
  }

  function moveProperty(id: string, direction: -1 | 1) {
    const index = rowProps.findIndex((prop) => prop.id === id);
    const target = rowProps[index + direction];
    if (index < 0 || !target) return;
    reorderProperty(id, target.id, direction < 0 ? "before" : "after");
  }

  function updatePropertyDisplay(prop: DbProperty, patch: NonNullable<DbProperty["config"]>) {
    updateProperty(prop.id, { config: { ...prop.config, ...patch } });
  }

  function renderCustomizeMenu() {
    return (
      <>
        <button
          type="button"
          className={styles.menuBackdrop}
          onClick={() => closeMenus(true)}
          tabIndex={-1}
          aria-label={t("rowProperties:closeCustomizeMenu")}
        />
        <div
          ref={customizeMenuRef}
          className={`${styles.rowCustomizeMenu} ${
            showCustomizeMenuOnly ? styles.rowCustomizeMenuFloating : ""
          }`}
          role="menu"
          tabIndex={-1}
          aria-label={t("rowProperties:customizeProperties")}
          onKeyDown={(e) => onMenuKeyDown(e, customizeMenuRef.current)}
        >
          <div className={styles.propMenuLabel}>{t("rowProperties:properties")}</div>
          <div className={styles.rowCustomizeSearch}>
            <Search size={14} aria-hidden="true" />
            <input
              ref={customizeSearchRef}
              value={customizeSearch}
              type="text"
              placeholder={t("rowProperties:searchProperties")}
              aria-label={t("rowProperties:searchProperties")}
              onChange={(e) => setCustomizeSearch(e.target.value)}
            />
          </div>
          <div className={styles.rowCustomizeList}>
            {filteredCustomizeProps.map((prop) => {
              const isShown = !prop.config?.hideInPagePanel;
              const canHideEmpty = canHideWhenEmpty(prop);
              return (
                <div key={prop.id} className={styles.rowCustomizeItem}>
                  <button
                    type="button"
                    className={styles.rowCustomizePrimary}
                    data-row-menu-item
                    role="menuitemcheckbox"
                    aria-checked={isShown}
                    onClick={() =>
                      updatePropertyDisplay(prop, {
                        hideInPagePanel: isShown,
                      })
                    }
                  >
                    <span className={styles.rowCustomizeMark} aria-hidden="true">
                      {isShown ? <CheckIcon size={14} /> : null}
                    </span>
                    <span className={styles.rowPropertyGlyph} aria-hidden="true">
                      <PropertyTypeIcon type={prop.type} size={15} />
                    </span>
                    <span className={styles.rowCustomizeText}>
                      <span className={styles.rowCustomizeName}>{prop.name}</span>
                      <span className={styles.rowCustomizeMeta}>
                        {propertyTypeLabel(prop.type)}
                        {prop.description ? ` · ${prop.description}` : ""}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.rowCustomizeEmpty}
                    data-row-menu-item
                    role="menuitemcheckbox"
                    aria-checked={!!prop.config?.hideWhenEmpty}
                    disabled={!canHideEmpty}
                    onClick={() =>
                      updatePropertyDisplay(prop, {
                        hideWhenEmpty: !prop.config?.hideWhenEmpty,
                      })
                    }
                  >
                    <span className={styles.rowCustomizeMark} aria-hidden="true">
                      {prop.config?.hideWhenEmpty ? <CheckIcon size={14} /> : null}
                    </span>
                    <span>{t("rowProperties:hideWhenEmpty")}</span>
                  </button>
                </div>
              );
            })}
            {filteredCustomizeProps.length === 0 && (
              <div className={styles.rowCustomizeEmptyState}>{t("rowProperties:noPropertiesFound")}</div>
            )}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className={styles.rowProperties}>
      {displayedProps.length === 0 && hiddenCount === 0 && (
        <div className={styles.rowPropertiesEmpty}>{t("rowProperties:noVisibleProperties")}</div>
      )}
      {displayedProps.map((prop) => {
        const rowPropIndex = rowProps.findIndex((item) => item.id === prop.id);
        const propertyIsEmpty = isEmptyRowProperty(row, prop);
        return (
          <div
            key={prop.id}
            className={styles.rowProperty}
            data-row-property-id={prop.id}
            data-property-dragging={draggingPropertyId === prop.id ? "true" : undefined}
            data-property-drag-over={dragOverPropertyId === prop.id ? "true" : undefined}
            data-drop-side={dragOverPropertyId === prop.id ? dragOverSide : undefined}
            onDragOver={(e) => {
              if (!canOpenPropertyMenus) return;
              const isPropertyDrag =
                draggingPropertyId || Array.from(e.dataTransfer.types).includes(ROW_PROPERTY_DRAG);
              if (!isPropertyDrag) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setDragOverPropertyId(prop.id);
              setDragOverSide(propertyDropSide(e));
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
              if (dragOverPropertyId === prop.id) {
                setDragOverPropertyId(null);
                setDragOverSide("before");
              }
            }}
            onDrop={(e) => {
              if (!canOpenPropertyMenus) return;
              const sourceId = draggingPropertyId || e.dataTransfer.getData(ROW_PROPERTY_DRAG);
              if (!sourceId) return;
              e.preventDefault();
              reorderProperty(sourceId, prop.id, propertyDropSide(e));
              clearPropertyDrag();
            }}
          >
            {!canOpenPropertyMenus ? (
              <div className={styles.rowPropertyName} data-readonly="true">
                <span className={styles.rowPropertyGlyph} aria-hidden="true">
                  <PropertyTypeIcon type={prop.type} size={15} />
                </span>
                <span className={styles.rowPropertyLabel} data-row-property-label>
                  {prop.name}
                </span>
              </div>
            ) : (
              <button
                type="button"
                className={styles.rowPropertyName}
                draggable
                aria-label={t("rowProperties:propertyOptions", { name: prop.name })}
                aria-haspopup="menu"
                aria-expanded={propertyMenuId === prop.id}
                onDragStart={(e) => {
                  closeMenus();
                  setDraggingPropertyId(prop.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(ROW_PROPERTY_DRAG, prop.id);
                }}
                onDragEnd={clearPropertyDrag}
                onClick={(e) => {
                  menuReturnRef.current = e.currentTarget;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const spaceBelow = window.innerHeight - rect.bottom;
                  setPropertyMenuPlacement(spaceBelow < 360 && rect.top > spaceBelow ? "above" : "below");
                  setAddOpen(false);
                  setCustomizeOpen(false);
                  setPropertyMenuId((current) => (current === prop.id ? null : prop.id));
                }}
              >
                <span className={styles.rowPropertyGlyph} aria-hidden="true">
                  <PropertyTypeIcon type={prop.type} size={15} />
                </span>
                <span className={styles.rowPropertyLabel} data-row-property-label>
                  {prop.name}
                </span>
              </button>
            )}
            <div
              className={styles.rowPropertyValue}
              data-row-property-empty={propertyIsEmpty ? "true" : undefined}
            >
              {readOnly ? (
                <div className={styles.rowPropertyReadonlyValue}>
                  <PropValue
                    row={row}
                    prop={prop}
                    interactive={relationNavigation && !!onOpenPage}
                    onOpenPage={relationNavigation ? onOpenPage : undefined}
                    pageHrefForRelation={relationNavigation ? pageHrefForRelation : undefined}
                    presentation="rowDetail"
                  />
                </div>
              ) : (
                <PropertyCell
                  row={row}
                  prop={prop}
                  onOpenPage={onOpenPage}
                  presentation="rowDetail"
                />
              )}
              {propertyIsEmpty && (
                <span className={styles.rowPropertyEmptyValue} aria-hidden="true">
                  {t("rowProperties:empty")}
                </span>
              )}
            </div>
            {canOpenPropertyMenus && propertyMenuId === prop.id && (
              <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeMenus(true)}
                  tabIndex={-1}
                  aria-label={t("rowProperties:closePropertyMenu")}
                />
                <div
                  ref={propertyMenuRef}
                  className={styles.rowPropertyMenu}
                  data-placement={propertyMenuPlacement}
                  role="menu"
                  tabIndex={-1}
                  aria-label={t("rowProperties:propertyOptions", { name: prop.name })}
                  onKeyDown={(e) => onMenuKeyDown(e, propertyMenuRef.current)}
                >
                  <label className={styles.propertyHeaderField}>
                    <span>{t("rowProperties:name")}</span>
                      <input
                        value={prop.name}
                        autoFocus
                        onChange={(e) => updateProperty(prop.id, { name: e.target.value })}
                        onKeyDown={(e) => {
                          if (isComposingKeyEvent(e)) return;
                          if (e.key !== "Escape" && e.key !== "Enter") return;
                          e.preventDefault();
                          closeMenus(true);
                        }}
                      />
                  </label>
                  <div className={styles.propertyHeaderField}>
                    <span>{t("rowProperties:type")}</span>
                    <NotionSelect
                      ariaLabel={t("rowProperties:propertyType")}
                      value={prop.type}
                      disabled={prop.type === "title" || isSystemProperty(prop)}
                      options={editablePropertyTypes(prop.type)}
                      onChange={(value) => {
                        const type = value as PropertyType;
                        confirmPropertyTypeChange(prop, type, () => {
                          updateProperty(prop.id, {
                            type,
                            config: configForType(type, prop.config, dbId),
                          });
                        });
                      }}
                    />
                  </div>
                  <label className={styles.propertyHeaderField}>
                    <span>{t("rowProperties:description")}</span>
                    <textarea
                      value={prop.description ?? ""}
                      placeholder={t("rowProperties:addDescription")}
                      rows={2}
                      onChange={(e) =>
                        updateProperty(prop.id, { description: e.target.value || undefined })
                      }
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        e.preventDefault();
                        closeMenus(true);
                      }}
                    />
                  </label>
                  <PropertyTypeConfig prop={prop} onClose={() => closeMenus(true)} />
                  <div className={styles.propertyHeaderRow}>
                    <button
                      type="button"
                      className={styles.propertyHeaderItem}
                      data-row-menu-item
                      disabled={rowPropIndex <= 0}
                      onClick={() => moveProperty(prop.id, -1)}
                    >
                      {t("rowProperties:moveUp")}
                    </button>
                    <button
                      type="button"
                      className={styles.propertyHeaderItem}
                      data-row-menu-item
                      disabled={rowPropIndex < 0 || rowPropIndex >= rowProps.length - 1}
                      onClick={() => moveProperty(prop.id, 1)}
                    >
                      {t("rowProperties:moveDown")}
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.propertyHeaderItem}
                    data-row-menu-item
                    role="menuitem"
                    onClick={() => {
                      updatePropertyDisplay(prop, {
                        hideInPagePanel: !prop.config?.hideInPagePanel,
                      });
                      setPropertyMenuId(null);
                      window.requestAnimationFrame(() => menuReturnRef.current?.focus());
                    }}
                  >
                    <span>{prop.config?.hideInPagePanel ? t("rowProperties:showProperty") : t("rowProperties:hideProperty")}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.propertyHeaderItem}
                    data-row-menu-item
                    role="menuitem"
                    disabled={prop.type === "title" || isSystemProperty(prop)}
                    onClick={() => void duplicatePropertyWithFeedback(prop)}
                  >
                    {t("rowProperties:duplicateProperty")}
                  </button>
                  {canHideWhenEmpty(prop) && (
                    <button
                      type="button"
                      className={styles.propertyHeaderItem}
                      data-row-menu-item
                      role="menuitemcheckbox"
                      aria-checked={!!prop.config?.hideWhenEmpty}
                      onClick={() => {
                        updatePropertyDisplay(prop, {
                          hideWhenEmpty: !prop.config?.hideWhenEmpty,
                        });
                        setPropertyMenuId(null);
                        window.requestAnimationFrame(() => menuReturnRef.current?.focus());
                      }}
                    >
                      <span aria-hidden="true">
                        {prop.config?.hideWhenEmpty ? <CheckIcon size={14} /> : null}
                      </span>
                      <span>{t("rowProperties:hideWhenEmpty")}</span>
                    </button>
                  )}
                  <div className={styles.propertyHeaderDivider} />
                  <button
                    type="button"
                    className={`${styles.propertyHeaderItem} ${styles.propertyDanger}`}
                    data-row-menu-item
                    role="menuitem"
                    disabled={prop.type === "title"}
                    onClick={() => void deletePropertyWithFeedback(prop)}
                  >
                    {t("rowProperties:deleteProperty")}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {hiddenCount > 0 && (
        <button
          type="button"
          className={styles.rowHiddenProperties}
          data-row-properties-toggle
          aria-expanded={showHiddenProperties}
          onClick={() =>
            setShowHiddenPropertiesFor((current) =>
              current === hiddenPropertiesKey ? null : hiddenPropertiesKey
            )
          }
        >
          {showHiddenProperties ? (
            <ChevronUp
              className={styles.rowHiddenPropertiesIcon}
              data-row-properties-toggle-icon="up"
              size={12}
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              className={styles.rowHiddenPropertiesIcon}
              data-row-properties-toggle-icon="down"
              size={12}
              aria-hidden="true"
            />
          )}
          {showHiddenProperties
            ? t("rowProperties:hideProperties")
            : t("rowProperties:moreProperties", { n: hiddenCount })}
        </button>
      )}
      {(canShowPropertyManagementControls || showCustomizeMenuOnly) && rowProps.length > 0 && (
        <div
          className={styles.rowCustomizeWrap}
          data-menu-only={showCustomizeMenuOnly ? "true" : undefined}
        >
          {canShowPropertyManagementControls && (
            <button
              ref={customizeButtonRef}
              type="button"
              className={styles.rowCustomizeButton}
              aria-haspopup="menu"
              aria-expanded={customizeOpen}
              onClick={(e) => {
                menuReturnRef.current = e.currentTarget;
                setAddOpen(false);
                setPropertyMenuId(null);
                setCustomizeOpen((current) => !current);
              }}
            >
              <Settings size={14} aria-hidden="true" />
              <span>{t("rowProperties:customizeProperties")}</span>
            </button>
          )}
          {customizeOpen &&
            (showCustomizeMenuOnly && typeof document !== "undefined"
              ? createPortal(renderCustomizeMenu(), document.body)
              : renderCustomizeMenu())}
        </div>
      )}
      {showBackReferences && backReferences.length > 0 && (
        <div className={styles.rowBackrefs}>
          <div className={styles.rowBackrefsLabel}>{t("rowProperties:linkedTo")}</div>
          {backReferences.map(({ page, propName }) => (
            <a
              key={`${page.id}-${propName}`}
              className={styles.rowBackref}
              href={pageHrefForRelation?.(page.id) ?? pageHref(page.id)}
              onClick={(e) => onPageLinkClick(page.id, e)}
              onAuxClick={(e) => e.stopPropagation()}
            >
              <FileText size={14} aria-hidden="true" />
              <span className={styles.rowBackrefTitle}>{pageDisplayTitle(page)}</span>
              <span className={styles.rowBackrefProp}>{propName}</span>
            </a>
          ))}
        </div>
      )}
      {canShowPropertyManagementControls && (
        <div className={styles.rowAddPropertyWrap}>
          <button
            ref={addButtonRef}
            type="button"
            className={styles.rowAddProperty}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={(e) => {
              menuReturnRef.current = e.currentTarget;
              if (addOpen) {
                closeMenus(false);
              } else {
                setPropertyMenuId(null);
                setCustomizeOpen(false);
                setAddOpen(true);
              }
            }}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t("rowProperties:addProperty")}</span>
          </button>
          {addOpen && (
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeMenus(true)}
                tabIndex={-1}
                aria-label={t("rowProperties:closeAddPropertyMenu")}
              />
              <div
                ref={addMenuRef}
                className={styles.rowAddPropertyMenu}
                role="menu"
                tabIndex={-1}
                aria-label={t("rowProperties:newPropertyType")}
                onKeyDown={(e) => onMenuKeyDown(e, addMenuRef.current)}
              >
                <div className={styles.propMenuLabel}>{t("rowProperties:newProperty")}</div>
                <label className={styles.propMenuSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={addSearchRef}
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        menuItems(addMenuRef.current)[0]?.focus();
                      } else if (e.key === "Enter" && filteredAddTypes[0]) {
                        e.preventDefault();
                        void createProperty(filteredAddTypes[0].type, filteredAddTypes[0].label);
                      }
                    }}
                    placeholder={t("rowProperties:searchPropertyTypes")}
                    aria-label={t("rowProperties:searchPropertyTypes")}
                  />
                </label>
                {filteredAddTypes.map((type) => (
                  <button
                    key={type.type}
                    type="button"
                    className={styles.propMenuItem}
                    data-row-menu-item
                    role="menuitem"
                    onClick={() => void createProperty(type.type, type.label)}
                  >
                    <span className={styles.propGlyph} aria-hidden="true">
                      <PropertyTypeIcon type={type.type} size={15} />
                    </span>
                    <span>{type.label}</span>
                  </button>
                ))}
                {filteredAddTypes.length === 0 && (
                  <div className={styles.propMenuEmpty}>{t("rowProperties:noPropertyTypesFound")}</div>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {typeChangeConfirmDialog}
    </div>
  );
}
