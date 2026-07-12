"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { newId } from "@/lib/ids";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type {
  DbProperty,
  Page,
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
import { CheckIcon, DragHandleIcon, Plus } from "../icons";
import styles from "./database.module.css";

const SELECT_OPTION_DRAG = "application/x-hanji-select-option-config";

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

/**
 * Type-specific configuration fields for a database property (relation database,
 * number format, rollup, formula). Self-contained so it can be reused by both the
 * table column header menu and the per-row property panel.
 */
export function PropertyTypeConfig({ prop, onClose }: { prop: DbProperty; onClose?: () => void }) {
  const { t } = useTranslation(["propertyTypeConfig", "common"]);
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
    value: format,
    label: t(`propertyTypeConfig:numberFormats.${format}`),
  }));
  const relationPropertyOptions = relationProps.map((relationProp) => ({
    value: relationProp.id,
    label: relationProp.name || t("propertyTypeConfig:untitled"),
    icon: <PropertyTypeIcon type={relationProp.type} size={14} />,
  }));
  const rollupTargetPropertyOptions = [
    { value: "", label: t("propertyTypeConfig:nameProperty") },
    ...rollupTargetProps.map((targetProp) => ({
      value: targetProp.id,
      label: targetProp.name || t("propertyTypeConfig:untitled"),
      icon: <PropertyTypeIcon type={targetProp.type} size={14} />,
    })),
  ];
  const rollupFunctionOptions = ROLLUP_FUNCTION_VALUES.map((fn) => ({
    value: fn,
    label: t(`propertyTypeConfig:rollupFunctions.${fn}`),
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
    return <RelationConfig prop={prop} databases={databases} databaseOptions={databaseOptions} />;
  }

  if (prop.type === "number") {
    return (
      <label className={styles.propertyHeaderField}>
        <span>{t("propertyTypeConfig:numberFormat")}</span>
        <NotionSelect
          ariaLabel={t("propertyTypeConfig:numberFormat")}
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
          <div className={styles.toolbarEmpty}>{t("propertyTypeConfig:addRelationFirst")}</div>
        ) : (
          <>
            <label className={styles.propertyHeaderField}>
              <span>{t("propertyTypeConfig:relation")}</span>
              <NotionSelect
                ariaLabel={t("propertyTypeConfig:ariaRollupRelation")}
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
              <span>{t("propertyTypeConfig:property")}</span>
              <NotionSelect
                ariaLabel={t("propertyTypeConfig:ariaRollupProperty")}
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
              <span>{t("propertyTypeConfig:calculate")}</span>
              <NotionSelect
                ariaLabel={t("propertyTypeConfig:ariaRollupCalculation")}
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
        <span>{t("propertyTypeConfig:idPrefix")}</span>
        <input
          value={prop.config?.idPrefix ?? ""}
          placeholder={t("propertyTypeConfig:idPrefixPlaceholder")}
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
        <span>{t("propertyTypeConfig:formula")}</span>
        <textarea
          className={styles.formulaInput}
          value={prop.config?.formula ?? ""}
          placeholder={t("propertyTypeConfig:formulaPlaceholder")}
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

/**
 * Relation config: pick the related database, and optionally make it a
 * Notion-style two-way ("Show on …") relation that creates and cross-links a
 * reciprocal relation property on the related database.
 */
function RelationConfig({
  prop,
  databases,
  databaseOptions,
}: {
  prop: DbProperty;
  databases: Page[];
  databaseOptions: { value: string; label: string }[];
}) {
  const { t } = useTranslation(["propertyTypeConfig", "common"]);
  const setRelationDatabase = useStore((s) => s.setRelationDatabase);
  const setRelationTwoWay = useStore((s) => s.setRelationTwoWay);
  const updateProperty = useStore((s) => s.updateProperty);
  const loadDatabase = useStore((s) => s.loadDatabase);

  const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;
  // A self-relation (target is the same database) is one-way only: Notion
  // recommends against two-way here because it just duplicates the property.
  const isSelfRelation = targetDbId === prop.databaseId;
  const linkedId = prop.config?.relatedPropertyId;
  const twoWay = Boolean(linkedId);
  const targetProps = useStore(useShallow((s) => s.dbProperties(targetDbId)));
  const reciprocal = linkedId
    ? targetProps.find((item) => item.id === linkedId)
    : undefined;
  const targetDb = databases.find((db) => db.id === targetDbId);
  const targetName = targetDb ? pageDisplayTitle(targetDb) : t("propertyTypeConfig:untitled");

  const [reciprocalName, setReciprocalName] = useState(reciprocal?.name ?? "");
  useEffect(() => {
    setReciprocalName(reciprocal?.name ?? "");
  }, [reciprocal?.id, reciprocal?.name]);

  // Load the target schema so the reciprocal property name renders when the
  // related database has not been opened yet.
  useEffect(() => {
    if (twoWay) void loadDatabase(targetDbId, { rows: false });
  }, [twoWay, targetDbId, loadDatabase]);

  function commitReciprocalName() {
    if (!reciprocal) return;
    const trimmed = reciprocalName.trim();
    if (!trimmed || trimmed === reciprocal.name) {
      setReciprocalName(reciprocal.name);
      return;
    }
    updateProperty(reciprocal.id, { name: trimmed });
  }

  return (
    <div className={styles.propertyHeaderFieldset}>
      <label className={styles.propertyHeaderField}>
        <span>{t("propertyTypeConfig:relationDatabase")}</span>
        <NotionSelect
          ariaLabel={t("propertyTypeConfig:relationDatabase")}
          value={targetDbId}
          options={databaseOptions}
          onChange={(value) => void setRelationDatabase(prop.id, value)}
        />
      </label>
      {!isSelfRelation && (
        <>
          <label className={styles.propertyHeaderToggle}>
            <input
              type="checkbox"
              checked={twoWay}
              aria-label={t("propertyTypeConfig:showOnDatabase", { name: targetName })}
              onChange={(e) => void setRelationTwoWay(prop.id, e.target.checked)}
            />
            <span>{t("propertyTypeConfig:showOnDatabase", { name: targetName })}</span>
          </label>
          {twoWay && (
            <label className={styles.propertyHeaderField}>
              <span>{t("propertyTypeConfig:relatedPropertyName")}</span>
              <input
                value={reciprocalName}
                aria-label={t("propertyTypeConfig:relatedPropertyName")}
                onChange={(e) => setReciprocalName(e.target.value)}
                onBlur={commitReciprocalName}
                onKeyDown={(e) => {
                  if (isComposingKeyEvent(e)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                }}
              />
            </label>
          )}
        </>
      )}
    </div>
  );
}

function SelectOptionsConfig({ prop }: { prop: DbProperty }) {
  const { t } = useTranslation(["propertyTypeConfig", "common"]);
  const updateProperty = useStore((s) => s.updateProperty);
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
    const trimmed = base.trim() || t("propertyTypeConfig:defaultOptionName");
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
      name: uniqueOptionName(newOptionName || t("propertyTypeConfig:defaultOptionName")),
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
    renameOption(id, uniqueOptionName(t("propertyTypeConfig:defaultOptionName")));
  }

  function setOptionColor(id: string, color: ColorName) {
    updateOptions(options.map((option) => (option.id === id ? { ...option, color } : option)));
    setOpenColorId(null);
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
        <span>{t("propertyTypeConfig:options")}</span>
        <span>{t("propertyTypeConfig:optionCount", { n: options.length })}</span>
      </div>
      <div className={styles.propertyOptionAdd}>
        <input
          value={newOptionName}
          placeholder={t("propertyTypeConfig:optionName")}
          aria-label={t("propertyTypeConfig:newOptionName")}
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
          <span>{t("propertyTypeConfig:addOption")}</span>
        </button>
      </div>
      <div className={styles.propertyOptionList}>
        {options.length === 0 ? (
          <div className={styles.propertyOptionEmpty}>{t("propertyTypeConfig:noOptionsYet")}</div>
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
                aria-label={t("propertyTypeConfig:reorderOption", { name: option.name })}
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
                aria-label={t("propertyTypeConfig:changeOptionColor", { name: option.name })}
                aria-expanded={openColorId === option.id}
                aria-haspopup="dialog"
                onClick={() => setOpenColorId((current) => (current === option.id ? null : option.id))}
              >
                <span style={chipStyle(option.color)} />
              </button>
              <input
                value={option.name}
                aria-label={t("propertyTypeConfig:optionNameAria", { name: option.name })}
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
              {openColorId === option.id && (
                <div
                  className={styles.propertyOptionSwatches}
                  role="dialog"
                  aria-label={t("propertyTypeConfig:optionColors", { name: option.name })}
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
