"use client";

import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { pickLabels } from "@/lib/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { newId } from "@/lib/ids";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type {
  DbProperty,
  PropertyConfig,
  RollupFunction,
  SelectOption,
} from "@/lib/types";
import { useStore } from "@/lib/store";
import { NUMBER_FORMATS, numberFormatForProperty } from "./numberFormat";
import { formulaWarnings } from "./formula";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { COLOR_NAMES, chipStyle, nextColor, type ColorName } from "./colors";
import { CheckIcon, DragHandleIcon, Plus, Trash } from "../icons";
import styles from "./database.module.css";

const SELECT_OPTION_DRAG = "application/x-notionlike-select-option-config";

const ROLLUP_FUNCTION_VALUES: RollupFunction[] = [
  "show_original",
  "count_all",
  "count_values",
  "count_unique",
  "count_empty",
  "percent_empty",
  "percent_not_empty",
  "checked",
  "unchecked",
  "percent_checked",
  "percent_unchecked",
  "sum",
  "average",
  "median",
  "min",
  "max",
  "range",
  "earliest_date",
  "latest_date",
  "date_range",
];

const PROPERTY_TYPE_CONFIG_LABELS = {
  en: {
    addOption: "Add option",
    addRelationFirst: "Add a relation property first.",
    calculate: "Calculate",
    changeOptionColor: (name: string) => `Change ${name} color`,
    defaultOptionName: "Option",
    deleteOptionAria: (name: string) => `Delete ${name} option`,
    deleteOptionFailed: "Couldn't delete option",
    deletedOption: "Deleted option",
    formula: "Formula",
    formulaPlaceholder: 'e.g. prop("Name")',
    newOptionName: "New option name",
    noOptionsYet: "No options yet",
    numberFormat: "Number format",
    optionColors: (name: string) => `${name} option colors`,
    optionCount: (count: number) => `${count}`,
    optionName: "Option name",
    optionNameAria: (name: string) => `${name} option name`,
    options: "Options",
    property: "Property",
    relation: "Relation",
    relationDatabase: "Relation database",
    reorderOption: (name: string) => `Reorder ${name} option`,
    restoreOptionFailed: "Couldn't restore option",
    restoredOption: "Restored option",
    rollupFunctions: {
      show_original: "Show original",
      count_all: "Count all",
      count_values: "Count values",
      count_unique: "Count unique values",
      count_empty: "Count empty",
      percent_empty: "Percent empty",
      percent_not_empty: "Percent not empty",
      checked: "Checked",
      unchecked: "Unchecked",
      percent_checked: "Percent checked",
      percent_unchecked: "Percent unchecked",
      sum: "Sum",
      average: "Average",
      median: "Median",
      min: "Min",
      max: "Max",
      range: "Range",
      earliest_date: "Earliest date",
      latest_date: "Latest date",
      date_range: "Date range",
    } as Record<RollupFunction, string>,
    undo: "Undo",
  },
  ko: {
    addOption: "옵션 추가",
    addRelationFirst: "먼저 관계형 속성을 추가하세요.",
    calculate: "계산",
    changeOptionColor: (name: string) => `${name} 색상 변경`,
    defaultOptionName: "옵션",
    deleteOptionAria: (name: string) => `${name} 옵션 삭제`,
    deleteOptionFailed: "옵션을 삭제하지 못했어요",
    deletedOption: "옵션을 삭제했어요",
    formula: "수식",
    formulaPlaceholder: '예: prop("Name")',
    newOptionName: "새 옵션 이름",
    noOptionsYet: "아직 옵션이 없습니다",
    numberFormat: "숫자 형식",
    optionColors: (name: string) => `${name} 옵션 색상`,
    optionCount: (count: number) => `${count}개`,
    optionName: "옵션 이름",
    optionNameAria: (name: string) => `${name} 옵션 이름`,
    options: "옵션",
    property: "속성",
    relation: "관계형",
    relationDatabase: "관계형 데이터베이스",
    reorderOption: (name: string) => `${name} 옵션 순서 변경`,
    restoreOptionFailed: "옵션을 복원하지 못했어요",
    restoredOption: "옵션을 복원했어요",
    rollupFunctions: {
      show_original: "원본 표시",
      count_all: "전체 개수",
      count_values: "값 있는 항목 수",
      count_unique: "고유 값 수",
      count_empty: "빈 값 수",
      percent_empty: "빈 값 비율",
      percent_not_empty: "비어 있지 않은 값 비율",
      checked: "체크됨",
      unchecked: "체크 안 됨",
      percent_checked: "체크됨 비율",
      percent_unchecked: "체크 안 됨 비율",
      sum: "합계",
      average: "평균",
      median: "중앙값",
      min: "최솟값",
      max: "최댓값",
      range: "범위",
      earliest_date: "가장 이른 날짜",
      latest_date: "가장 늦은 날짜",
      date_range: "날짜 범위",
    } as Record<RollupFunction, string>,
    undo: "되돌리기",
  },
} as const;

function propertyTypeConfigLabels() {
  return pickLabels(PROPERTY_TYPE_CONFIG_LABELS);
}

/**
 * Type-specific configuration fields for a database property (relation database,
 * number format, rollup, formula). Self-contained so it can be reused by both the
 * table column header menu and the per-row property panel.
 */
export function PropertyTypeConfig({ prop, onClose }: { prop: DbProperty; onClose?: () => void }) {
  const updateProperty = useStore((s) => s.updateProperty);
  const loadDatabase = useStore((s) => s.loadDatabase);
  const sourceProps = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const databases = useStore(
    useShallow((s) =>
      Object.values(s.pagesById)
        .filter((page) => page.kind === "database" && !page.inTrash)
        .sort((a, b) => a.title.localeCompare(b.title) || a.position - b.position)
    )
  );

  const relationProps = sourceProps.filter((item) => item.type === "relation");
  const rollupRelation =
    relationProps.find((item) => item.id === prop.config?.rollupRelationPropertyId) ??
    relationProps[0];
  const rollupDatabaseId =
    rollupRelation?.config?.relationDatabaseId ?? rollupRelation?.databaseId;
  const rollupTargetProps = useStore(
    useShallow((s) => (rollupDatabaseId ? s.dbProperties(rollupDatabaseId) : []))
  );
  const databaseOptions = databases.map((database) => ({
    value: database.id,
    label: pageDisplayTitle(database),
  }));
  const numberFormatOptions = NUMBER_FORMATS.map((format) => ({
    value: format.value,
    label: format.label,
  }));
  const relationPropertyOptions = relationProps.map((relationProp) => ({
    value: relationProp.id,
    label: relationProp.name || "Untitled",
    icon: <PropertyTypeIcon type={relationProp.type} size={14} />,
  }));
  const rollupTargetPropertyOptions = [
    { value: "", label: "Name" },
    ...rollupTargetProps.map((targetProp) => ({
      value: targetProp.id,
      label: targetProp.name || "Untitled",
      icon: <PropertyTypeIcon type={targetProp.type} size={14} />,
    })),
  ];
  const rollupFunctionOptions = ROLLUP_FUNCTION_VALUES.map((fn) => ({
    value: fn,
    label: propertyTypeConfigLabels().rollupFunctions[fn],
  }));

  useEffect(() => {
    if (rollupDatabaseId) void loadDatabase(rollupDatabaseId);
  }, [loadDatabase, rollupDatabaseId]);

  // A freshly created rollup has no relation set; persist the fallback so the cell
  // doesn't render blank.
  useEffect(() => {
    if (prop.type === "rollup" && !prop.config?.rollupRelationPropertyId && rollupRelation) {
      updateProperty(prop.id, {
        config: { ...prop.config, rollupRelationPropertyId: rollupRelation.id },
      });
    }
  }, [prop.id, prop.type, prop.config, rollupRelation, updateProperty]);

  function onFieldKeyDown(e: React.KeyboardEvent) {
    if (isComposingKeyEvent(e)) return;
    if (e.key !== "Escape") return;
    e.preventDefault();
    onClose?.();
  }

  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    return <SelectOptionsConfig prop={prop} />;
  }

  if (prop.type === "relation") {
    return (
      <label className={styles.propertyHeaderField}>
        <span>{propertyTypeConfigLabels().relationDatabase}</span>
        <NotionSelect
          ariaLabel="Relation database"
          value={prop.config?.relationDatabaseId ?? prop.databaseId}
          options={databaseOptions}
          onChange={(value) =>
            updateProperty(prop.id, {
              config: { ...prop.config, relationDatabaseId: value },
            })
          }
        />
      </label>
    );
  }

  if (prop.type === "number") {
    return (
      <label className={styles.propertyHeaderField}>
        <span>{propertyTypeConfigLabels().numberFormat}</span>
        <NotionSelect
          ariaLabel="Number format"
          value={numberFormatForProperty(prop)}
          options={numberFormatOptions}
          onChange={(value) =>
            updateProperty(prop.id, {
              config: {
                ...prop.config,
                numberFormat: value as NonNullable<PropertyConfig["numberFormat"]>,
              },
            })
          }
        />
      </label>
    );
  }

  if (prop.type === "rollup") {
    return (
      <div className={styles.propertyHeaderFieldset}>
        {relationProps.length === 0 ? (
          <div className={styles.toolbarEmpty}>{propertyTypeConfigLabels().addRelationFirst}</div>
        ) : (
          <>
            <label className={styles.propertyHeaderField}>
              <span>{propertyTypeConfigLabels().relation}</span>
              <NotionSelect
                ariaLabel="Rollup relation"
                value={rollupRelation?.id ?? ""}
                options={relationPropertyOptions}
                onChange={(value) =>
                  updateProperty(prop.id, {
                    config: {
                      ...prop.config,
                      rollupRelationPropertyId: value,
                      rollupTargetPropertyId: undefined,
                      rollupFunction: prop.config?.rollupFunction ?? "show_original",
                    },
                  })
                }
              />
            </label>
            <label className={styles.propertyHeaderField}>
              <span>{propertyTypeConfigLabels().property}</span>
              <NotionSelect
                ariaLabel="Rollup property"
                value={prop.config?.rollupTargetPropertyId ?? ""}
                options={rollupTargetPropertyOptions}
                onChange={(value) =>
                  updateProperty(prop.id, {
                    config: {
                      ...prop.config,
                      rollupRelationPropertyId: rollupRelation?.id,
                      rollupTargetPropertyId: value || undefined,
                      rollupFunction: prop.config?.rollupFunction ?? "show_original",
                    },
                  })
                }
              />
            </label>
            <label className={styles.propertyHeaderField}>
              <span>{propertyTypeConfigLabels().calculate}</span>
              <NotionSelect
                ariaLabel="Rollup calculation"
                value={prop.config?.rollupFunction ?? "show_original"}
                options={rollupFunctionOptions}
                onChange={(value) =>
                  updateProperty(prop.id, {
                    config: {
                      ...prop.config,
                      rollupRelationPropertyId: rollupRelation?.id,
                      rollupFunction: value as RollupFunction,
                    },
                  })
                }
              />
            </label>
          </>
        )}
      </div>
    );
  }

  if (prop.type === "unique_id") {
    return (
      <label className={styles.propertyHeaderField}>
        <span>ID prefix</span>
        <input
          value={prop.config?.idPrefix ?? ""}
          placeholder="e.g. TASK"
          onKeyDown={onFieldKeyDown}
          onChange={(e) =>
            updateProperty(prop.id, { config: { ...prop.config, idPrefix: e.target.value } })
          }
        />
      </label>
    );
  }

  if (prop.type === "formula") {
    return (
      <label className={styles.propertyHeaderField}>
        <span>{propertyTypeConfigLabels().formula}</span>
        <textarea
          className={styles.formulaInput}
          value={prop.config?.formula ?? ""}
          placeholder={propertyTypeConfigLabels().formulaPlaceholder}
          onKeyDown={onFieldKeyDown}
          onChange={(e) =>
            updateProperty(prop.id, { config: { ...prop.config, formula: e.target.value } })
          }
        />
        {formulaWarnings(prop.config?.formula, sourceProps).map((warning) => (
          <span key={warning} className={styles.formulaWarning}>
            {warning}
          </span>
        ))}
      </label>
    );
  }

  return null;
}

function SelectOptionsConfig({ prop }: { prop: DbProperty }) {
  const updateProperty = useStore((s) => s.updateProperty);
  const deletePropertyOption = useStore((s) => s.deletePropertyOption);
  const restoreDeletedPropertyOption = useStore((s) => s.restoreDeletedPropertyOption);
  const notify = useStore((s) => s.notify);
  const [newOptionName, setNewOptionName] = useState("");
  const [openColorId, setOpenColorId] = useState<string | null>(null);
  const [draggingOptionId, setDraggingOptionId] = useState<string | null>(null);
  const [dragOverOptionId, setDragOverOptionId] = useState<string | null>(null);
  const [dragOverOptionSide, setDragOverOptionSide] = useState<"before" | "after">("before");

  const options = prop.config?.options ?? [];

  function updateOptions(next: SelectOption[]) {
    updateProperty(prop.id, { config: { ...prop.config, options: next } });
  }

  function uniqueOptionName(base: string) {
    const names = new Set(options.map((option) => option.name.trim().toLowerCase()));
    const trimmed = base.trim() || propertyTypeConfigLabels().defaultOptionName;
    if (!names.has(trimmed.toLowerCase())) return trimmed;
    for (let i = 2; i < 1000; i += 1) {
      const candidate = `${trimmed} ${i}`;
      if (!names.has(candidate.toLowerCase())) return candidate;
    }
    return `${trimmed} ${newId().slice(0, 4)}`;
  }

  function createOption() {
    const option: SelectOption = {
      id: newId(),
      name: uniqueOptionName(newOptionName || propertyTypeConfigLabels().defaultOptionName),
      color: nextColor(options.length),
    };
    updateOptions([...options, option]);
    setNewOptionName("");
    setOpenColorId(option.id);
  }

  function renameOption(id: string, name: string) {
    updateOptions(options.map((option) => (option.id === id ? { ...option, name } : option)));
  }

  function commitOptionName(id: string, name: string) {
    const trimmed = name.trim();
    if (trimmed) {
      renameOption(id, trimmed);
      return;
    }
    renameOption(id, uniqueOptionName(propertyTypeConfigLabels().defaultOptionName));
  }

  function setOptionColor(id: string, color: ColorName) {
    updateOptions(options.map((option) => (option.id === id ? { ...option, color } : option)));
    setOpenColorId(null);
  }

  async function deleteOption(id: string) {
    const snapshot = await deletePropertyOption(prop.id, id);
    if (!snapshot) {
      notify(propertyTypeConfigLabels().deleteOptionFailed, "error");
      return;
    }
    setOpenColorId(null);
    notify(propertyTypeConfigLabels().deletedOption, "success", {
      label: propertyTypeConfigLabels().undo,
      onClick: async () => {
        const restored = await restoreDeletedPropertyOption(snapshot);
        notify(
          restored ? propertyTypeConfigLabels().restoredOption : propertyTypeConfigLabels().restoreOptionFailed,
          restored ? "success" : "error"
        );
      },
    });
  }

  function clearOptionDrag() {
    setDraggingOptionId(null);
    setDragOverOptionId(null);
    setDragOverOptionSide("before");
  }

  function optionDropSide(e: React.DragEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }

  function reorderOption(sourceId: string, targetId: string, side: "before" | "after") {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const source = options.find((option) => option.id === sourceId);
    if (!source) return;
    const next = options.filter((option) => option.id !== sourceId);
    const targetIndex = next.findIndex((option) => option.id === targetId);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (side === "after" ? 1 : 0), 0, source);
    updateOptions(next);
  }

  return (
    <div className={styles.propertyOptionConfig}>
      <div className={styles.propertyOptionHead}>
        <span>{propertyTypeConfigLabels().options}</span>
        <span>{propertyTypeConfigLabels().optionCount(options.length)}</span>
      </div>
      <div className={styles.propertyOptionAdd}>
        <input
          value={newOptionName}
          placeholder={propertyTypeConfigLabels().optionName}
          aria-label={propertyTypeConfigLabels().newOptionName}
          onChange={(e) => setNewOptionName(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKeyEvent(e)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              createOption();
            }
          }}
        />
        <button type="button" onClick={createOption}>
          <Plus size={14} aria-hidden="true" />
          <span>{propertyTypeConfigLabels().addOption}</span>
        </button>
      </div>
      <div className={styles.propertyOptionList}>
        {options.length === 0 ? (
          <div className={styles.propertyOptionEmpty}>{propertyTypeConfigLabels().noOptionsYet}</div>
        ) : (
          options.map((option) => (
            <div
              key={option.id}
              className={styles.propertyOptionRow}
              data-option-dragging={draggingOptionId === option.id ? "true" : undefined}
              data-option-drag-over={dragOverOptionId === option.id ? "true" : undefined}
              data-drop-side={dragOverOptionId === option.id ? dragOverOptionSide : undefined}
              onDragOver={(e) => {
                const isOptionDrag =
                  draggingOptionId || Array.from(e.dataTransfer.types).includes(SELECT_OPTION_DRAG);
                if (!isOptionDrag || draggingOptionId === option.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDragOverOptionId(option.id);
                setDragOverOptionSide(optionDropSide(e));
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                if (dragOverOptionId === option.id) {
                  setDragOverOptionId(null);
                  setDragOverOptionSide("before");
                }
              }}
              onDrop={(e) => {
                const sourceId = e.dataTransfer.getData(SELECT_OPTION_DRAG) || draggingOptionId;
                if (!sourceId) return;
                e.preventDefault();
                reorderOption(sourceId, option.id, optionDropSide(e));
                clearOptionDrag();
              }}
            >
              <button
                type="button"
                className={styles.propertyOptionDrag}
                draggable
                aria-label={propertyTypeConfigLabels().reorderOption(option.name)}
                onDragStart={(e) => {
                  setDraggingOptionId(option.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData(SELECT_OPTION_DRAG, option.id);
                }}
                onDragEnd={clearOptionDrag}
              >
                <DragHandleIcon size={14} aria-hidden="true" />
              </button>
              <button
                type="button"
                className={styles.propertyOptionColor}
                aria-label={propertyTypeConfigLabels().changeOptionColor(option.name)}
                aria-expanded={openColorId === option.id}
                aria-haspopup="dialog"
                onClick={() => setOpenColorId((current) => (current === option.id ? null : option.id))}
              >
                <span style={chipStyle(option.color)} />
              </button>
              <input
                value={option.name}
                aria-label={propertyTypeConfigLabels().optionNameAria(option.name)}
                onChange={(e) => renameOption(option.id, e.target.value)}
                onBlur={(e) => commitOptionName(option.id, e.target.value)}
                onKeyDown={(e) => {
                  if (isComposingKeyEvent(e)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
              <button
                type="button"
                className={styles.propertyOptionDelete}
                aria-label={propertyTypeConfigLabels().deleteOptionAria(option.name)}
                onClick={() => void deleteOption(option.id)}
              >
                <Trash size={13} aria-hidden="true" />
              </button>
              {openColorId === option.id && (
                <div
                  className={styles.propertyOptionSwatches}
                  role="dialog"
                  aria-label={propertyTypeConfigLabels().optionColors(option.name)}
                >
                  {COLOR_NAMES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={styles.optionSwatch}
                      data-active={option.color === color ? "true" : undefined}
                      aria-label={color}
                      style={chipStyle(color)}
                      onClick={() => setOptionColor(option.id, color)}
                    >
                      {option.color === color && <CheckIcon size={12} aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
