import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { useStore } from "@/lib/store";
import type {
  DbProperty,
  FilterGroup,
  FilterOperator,
  OrganizationProfile,
  ViewFilter,
  ViewSort,
  WorkspaceMember,
} from "@/lib/types";
import { ArrowDown, ArrowUp, Plus, X } from "@/icons/hanji";
import { PageIconGlyph } from "../PageIcon";
import { DateTextInput } from "./DateTextInput";
import { NumberTextInput } from "./NumberTextInput";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { personLabel } from "./people";
import { propertyTypeLabel as typeLabel } from "./propertyTypes";
import {
  currentPageFilterValue,
  isCurrentPageFilterValue,
} from "./query";
import {
  DATE_ROLLUP_FUNCTIONS,
  NO_VALUE_FILTERS,
  NUMERIC_ROLLUP_FUNCTIONS,
  databaseViewLabels,
  filterOperatorLabels,
} from "./databaseViewLabels";
import styles from "./database.module.css";
import filterStyles from "./filterGroups.module.css";

function effectiveFilterOperator(
  prop: DbProperty,
  operator: FilterOperator
): FilterOperator {
  const operators = operatorsFor(prop);
  return operators.includes(operator) ? operator : operators[0];
}

export function propertyTypeLabel(prop: DbProperty) {
  return typeLabel(prop.type);
}

export function ViewNameField({
  name,
  onCommit,
  onClose,
}: {
  name: string;
  onCommit: (name: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(name);

  function commit() {
    const next = draft.trim() || databaseViewLabels().untitled;
    if (next !== name) onCommit(next);
  }

  return (
    <label className={styles.viewNameField}>
      <span>{databaseViewLabels().viewName}</span>
      <input
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isComposingKeyEvent(e)) return;
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            onClose();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setDraft(name);
            onClose();
          }
        }}
      />
    </label>
  );
}

type FilterGroupEditorProps = {
  group: FilterGroup;
  path: number[];
  props: DbProperty[];
  onSetConjunction: (path: number[], next: "and" | "or") => void;
  onUpdateFilter: (path: number[], index: number, patch: Partial<ViewFilter>) => void;
  onRemoveFilter: (path: number[], index: number) => void;
  onRemoveGroup: (parentPath: number[], index: number) => void;
  onAddFilter: (path: number[]) => void;
  onAddGroup: (path: number[]) => void;
};

/**
 * Recursive editor for one filter group. Its terms are this group's leaf rows
 * followed by its sub-groups; the And/Or connector sits before every term after
 * the first. The first connector is the editable toggle that flips the whole
 * group's conjunction; later connectors are static labels (matching the existing
 * flat-filter UX). Sub-groups render the same editor one level deeper and carry a
 * left border for visual nesting.
 */
export function FilterGroupEditor(props: FilterGroupEditorProps) {
  const {
    group,
    path,
    props: dbProps,
    onSetConjunction,
    onUpdateFilter,
    onRemoveFilter,
    onRemoveGroup,
    onAddFilter,
    onAddGroup,
  } = props;
  const subgroups = group.groups ?? [];
  const conjunction = group.conjunction === "or" ? "or" : "and";

  // `termIndex` is the position of a term among (leaves + subgroups) so the
  // connector logic matches the original flat UX: editable toggle at index 1,
  // static label at index 2+.
  function connector(termIndex: number) {
    if (termIndex === 0) return null;
    return (
      <div className={filterStyles.conjunctionRow}>
        {termIndex === 1 ? (
          <div className={filterStyles.conjunctionToggle}>
            {(["and", "or"] as const).map((c) => (
              <button
                key={c}
                type="button"
                data-active={conjunction === c ? "true" : undefined}
                onClick={() => onSetConjunction(path, c)}
              >
                {c === "and" ? databaseViewLabels().and : databaseViewLabels().or}
              </button>
            ))}
          </div>
        ) : (
          <span className={filterStyles.conjunctionLabel}>
            {conjunction === "and" ? databaseViewLabels().and : databaseViewLabels().or}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className={filterStyles.group}>
      {group.filters.map((filter, index) => (
        <div key={`leaf-${index}`}>
          {connector(index)}
          <FilterRow
            filter={filter}
            props={dbProps}
            onChange={(patch) => onUpdateFilter(path, index, patch)}
            onRemove={() => onRemoveFilter(path, index)}
          />
        </div>
      ))}
      {subgroups.map((sub, subIndex) => {
        const termIndex = group.filters.length + subIndex;
        return (
          <div key={`group-${subIndex}`}>
            {connector(termIndex)}
            <div className={filterStyles.subgroup}>
              <div className={filterStyles.subgroupHead}>
                <span className={filterStyles.conjunctionLabel}>{databaseViewLabels().filterGroup}</span>
                <button
                  type="button"
                  className={filterStyles.groupRemove}
                  aria-label={databaseViewLabels().removeFilterGroup}
                  onClick={() => onRemoveGroup(path, subIndex)}
                >
                  <X size={14} />
                </button>
              </div>
              <FilterGroupEditor
                group={sub}
                path={[...path, subIndex]}
                props={dbProps}
                onSetConjunction={onSetConjunction}
                onUpdateFilter={onUpdateFilter}
                onRemoveFilter={onRemoveFilter}
                onRemoveGroup={onRemoveGroup}
                onAddFilter={onAddFilter}
                onAddGroup={onAddGroup}
              />
            </div>
          </div>
        );
      })}
      <div className={filterStyles.addRow}>
        <button type="button" className={filterStyles.addBtn} onClick={() => onAddFilter(path)}>
          <Plus size={14} /> {databaseViewLabels().addFilter}
        </button>
        <button type="button" className={filterStyles.addBtn} onClick={() => onAddGroup(path)}>
          <Plus size={14} /> {databaseViewLabels().addFilterGroup}
        </button>
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  props,
  onChange,
  onRemove,
}: {
  filter: ViewFilter;
  props: DbProperty[];
  onChange: (patch: Partial<ViewFilter>) => void;
  onRemove: () => void;
}) {
  const prop = props.find((p) => p.id === filter.propertyId) ?? props[0];
  if (!prop) return null;
  const operators = operatorsFor(prop);
  const operator = effectiveFilterOperator(prop, filter.operator);
  const propertyOptions = props.map((p) => ({
    value: p.id,
    label: p.name || databaseViewLabels().untitled,
    icon: <PropertyTypeIcon type={p.type} size={14} />,
  }));
  const operatorLabels = filterOperatorLabels();
  const operatorOptions = operators.map((op) => ({ value: op, label: operatorLabels[op] }));

  return (
    <div className={styles.ruleRow} data-filter-row>
      <NotionSelect
        ariaLabel={databaseViewLabels().filterProperty}
        value={prop.id}
        options={propertyOptions}
        onChange={(value) => {
          const nextProp = props.find((p) => p.id === value) ?? prop;
          onChange({
            propertyId: nextProp.id,
            operator: defaultOperator(nextProp),
            value: defaultValue(nextProp),
          });
        }}
      />
      <NotionSelect
        ariaLabel={databaseViewLabels().filterCondition}
        value={operator}
        options={operatorOptions}
        onChange={(value) => onChange({ operator: value as FilterOperator })}
      />
      {!NO_VALUE_FILTERS.has(operator) ? (
        <FilterValueInput
          prop={prop}
          value={filter.value}
          onChange={(value) => onChange({ operator, value })}
        />
      ) : (
        <span className={styles.ruleSpacer} />
      )}
      <button type="button" className={styles.ruleRemove} aria-label={databaseViewLabels().removeFilter} onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

export function SortRow({
  sort,
  props,
  canMoveUp,
  canMoveDown,
  onMove,
  onChange,
  onRemove,
}: {
  sort: ViewSort;
  props: DbProperty[];
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: -1 | 1) => void;
  onChange: (patch: Partial<ViewSort>) => void;
  onRemove: () => void;
}) {
  const propertyOptions = props.map((p) => ({
    value: p.id,
    label: p.name || databaseViewLabels().untitled,
    icon: <PropertyTypeIcon type={p.type} size={14} />,
  }));
  return (
    <div className={styles.ruleRow} data-sort-row>
      <NotionSelect
        ariaLabel={databaseViewLabels().sortProperty}
        value={sort.propertyId}
        options={propertyOptions}
        onChange={(value) => onChange({ propertyId: value })}
      />
      <NotionSelect
        ariaLabel={databaseViewLabels().sortDirection}
        value={sort.direction}
        options={[
          { value: "asc", label: databaseViewLabels().ascending },
          { value: "desc", label: databaseViewLabels().descending },
        ]}
        onChange={(value) => onChange({ direction: value as ViewSort["direction"] })}
      />
      <div className={styles.ruleReorder}>
        <button
          type="button"
          aria-label={databaseViewLabels().moveSortUp}
          disabled={!canMoveUp}
          onClick={() => onMove(-1)}
        >
          <ArrowUp size={13} />
        </button>
        <button
          type="button"
          aria-label={databaseViewLabels().moveSortDown}
          disabled={!canMoveDown}
          onClick={() => onMove(1)}
        >
          <ArrowDown size={13} />
        </button>
      </div>
      <button type="button" className={styles.ruleRemove} aria-label={databaseViewLabels().removeSort} onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

function FilterValueInput({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (prop.type === "checkbox") {
    return (
      <NotionSelect
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={String(value ?? true)}
        options={[
          { value: "true", label: databaseViewLabels().checked },
          { value: "false", label: databaseViewLabels().unchecked },
        ]}
        onChange={(next) => onChange(next === "true")}
      />
    );
  }

  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    return (
      <NotionSelect
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={selectFilterValue(prop, value)}
        options={selectFilterOptions(prop, value)}
        onChange={onChange}
      />
    );
  }

  if (prop.type === "person" || prop.type === "created_by" || prop.type === "last_edited_by") {
    return <PersonFilterValue value={value} onChange={onChange} label={prop.name} />;
  }

  if (prop.type === "relation") {
    return <RelationFilterValue prop={prop} value={value} onChange={onChange} />;
  }

  if (prop.type === "rollup") {
    return <RollupFilterValue prop={prop} value={value} onChange={onChange} />;
  }

  if (prop.type === "date" || prop.type === "created_time" || prop.type === "last_edited_time") {
    return (
      <DateTextInput
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={value}
        onChange={onChange}
      />
    );
  }

  if (prop.type === "number" || prop.type === "unique_id") {
    return (
      <NumberTextInput
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={value}
        placeholder={databaseViewLabels().value}
        onChange={onChange}
      />
    );
  }

  return (
    <input
      aria-label={databaseViewLabels().filterValueFor(prop.name)}
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={databaseViewLabels().value}
    />
  );
}

function PersonFilterValue({
  value,
  onChange,
  label,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  label: string;
}) {
  const userId = useStore((s) => s.userId) ?? "local-user";
  const workspaceMembers = useStore(useShallow((s) => s.workspaceMembers));
  const organizationProfiles = useStore(useShallow((s) => s.organizationProfiles));
  const selectedValue = String(value ?? "").trim();
  const options = personFilterOptions({
    currentUserId: userId,
    organizationProfiles,
    selectedValue,
    workspaceMembers,
  });
  return (
    <NotionSelect
      ariaLabel={databaseViewLabels().filterValueFor(label)}
      value={selectedValue}
      options={options}
      onChange={onChange}
    />
  );
}

function RelationFilterValue({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;
  const loadDatabase = useStore((s) => s.loadDatabase);
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const rows = useStore(useShallow((s) => (targetDbId ? s.dbRows(targetDbId) : [])));
  const selectedValue = relationFilterSelectValue(value);
  const selectedRowId = selectedValue === "__current_page__" ? "" : selectedValue;
  const selectedRow = selectedRowId ? pagesById[selectedRowId] : undefined;
  const rowOptions = rows.map((row) => ({
    value: row.id,
    label: pageDisplayTitle(row),
    icon: <PageIconGlyph page={row} size={14} />,
  }));
  const selectedRowOption = selectedRowId
    ? rowOptions.find((option) => option.value === selectedRowId)
    : undefined;
  const orderedRowOptions = selectedRowOption
    ? [
        selectedRowOption,
        ...rowOptions.filter((option) => option.value !== selectedRowOption.value),
      ]
    : rowOptions;
  const selectedFallbackOption =
    selectedRowId && !selectedRowOption
      ? [
          {
            value: selectedRowId,
            label: selectedRow ? pageDisplayTitle(selectedRow) : selectedRowId,
            icon: selectedRow ? <PageIconGlyph page={selectedRow} size={14} /> : undefined,
          },
        ]
      : [];

  useEffect(() => {
    if (!targetDbId || targetDbId === prop.databaseId) return;
    void loadDatabase(targetDbId);
  }, [loadDatabase, prop.databaseId, targetDbId]);

  return (
    <NotionSelect
      ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
      value={selectedValue}
      options={[
        { value: "", label: databaseViewLabels().choosePage, disabled: true },
        { value: "__current_page__", label: databaseViewLabels().currentPage },
        ...selectedFallbackOption,
        ...orderedRowOptions,
      ]}
      onChange={(next) => onChange(next === "__current_page__" ? currentPageFilterValue() : next)}
    />
  );
}

function RollupFilterValue({
  prop,
  value,
  onChange,
}: {
  prop: DbProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const sourceProps = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const loadDatabase = useStore((s) => s.loadDatabase);
  const relationProp = sourceProps.find(
    (candidate) => candidate.type === "relation" && candidate.id === prop.config?.rollupRelationPropertyId
  );
  const firstHopDbId = relationProp?.config?.relationDatabaseId ?? relationProp?.databaseId;
  const firstHopProps = useStore(useShallow((s) => (firstHopDbId ? s.dbProperties(firstHopDbId) : [])));
  const targetProp = firstHopProps.find((candidate) => candidate.id === prop.config?.rollupTargetPropertyId);
  const rollupFunction = prop.config?.rollupFunction ?? "show_original";

  useEffect(() => {
    if (firstHopDbId) void loadDatabase(firstHopDbId, { rows: false });
  }, [firstHopDbId, loadDatabase]);

  if (NUMERIC_ROLLUP_FUNCTIONS.has(rollupFunction)) {
    return (
      <NumberTextInput
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={value}
        placeholder={databaseViewLabels().value}
        onChange={onChange}
      />
    );
  }

  if (DATE_ROLLUP_FUNCTIONS.has(rollupFunction)) {
    return (
      <DateTextInput
        ariaLabel={databaseViewLabels().filterValueFor(prop.name)}
        value={value}
        onChange={onChange}
      />
    );
  }

  const relationTargetDbId =
    !targetProp
      ? firstHopDbId
      : targetProp.type === "relation"
        ? targetProp.config?.relationDatabaseId ?? targetProp.databaseId
        : undefined;

  if (relationTargetDbId) {
    const relationLikeProp: DbProperty = {
      ...prop,
      type: "relation",
      config: { ...(prop.config ?? {}), relationDatabaseId: relationTargetDbId },
    };
    return <RelationFilterValue prop={relationLikeProp} value={value} onChange={onChange} />;
  }

  return (
    <input
      aria-label={databaseViewLabels().filterValueFor(prop.name)}
      type="text"
      value={value == null ? "" : String(value)}
      onChange={(e) => onChange(e.target.value)}
      placeholder={databaseViewLabels().value}
    />
  );
}

function relationFilterSelectValue(value: unknown) {
  if (isCurrentPageFilterValue(value)) return "__current_page__";
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => isCurrentPageFilterValue(item))) return "__current_page__";
  return values.map((item) => String(item ?? "").trim()).find(Boolean) ?? "";
}

function selectFilterValue(prop: DbProperty, value: unknown) {
  const raw = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  return (
    prop.config?.options?.find(
      (option) => option.id.toLowerCase() === lower || option.name.toLowerCase() === lower
    )?.id ?? raw
  );
}

function selectFilterOptions(prop: DbProperty, value: unknown) {
  const selected = selectFilterValue(prop, value);
  const options = [
    { value: "", label: databaseViewLabels().chooseOption, disabled: true },
    ...(prop.config?.options ?? []).map((option) => ({
      value: option.id,
      label: option.name,
    })),
  ];
  if (!selected || options.some((option) => option.value === selected)) return options;
  return [
    ...options,
    { value: selected, label: String(Array.isArray(value) ? value[0] ?? selected : value ?? selected) },
  ];
}

function operatorsFor(prop: DbProperty): FilterOperator[] {
  switch (prop.type) {
    case "number":
    case "unique_id":
      return ["equals", "does_not_equal", "greater_than", "less_than", "is_empty", "is_not_empty"];
    case "date":
    case "created_time":
    case "last_edited_time":
      return ["on_or_after", "on_or_before", "equals", "is_empty", "is_not_empty"];
    case "checkbox":
      return ["equals", "does_not_equal"];
    case "select":
    case "status":
      return ["equals", "does_not_equal", "is_empty", "is_not_empty"];
    case "multi_select":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "person":
    case "created_by":
    case "last_edited_by":
    case "relation":
      return ["contains", "does_not_contain", "is_empty", "is_not_empty"];
    case "files":
      return ["is_empty", "is_not_empty"];
    case "rollup":
      if (NUMERIC_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) {
        return ["equals", "does_not_equal", "greater_than", "less_than", "is_empty", "is_not_empty"];
      }
      if (DATE_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) {
        return ["on_or_after", "on_or_before", "equals", "is_empty", "is_not_empty"];
      }
      return ["contains", "does_not_contain", "equals", "does_not_equal", "is_empty", "is_not_empty"];
    default:
      return ["contains", "does_not_contain", "equals", "does_not_equal", "is_empty", "is_not_empty"];
  }
}

export function defaultOperator(prop: DbProperty): FilterOperator {
  // A select/status with no options can only sensibly filter on empty/not-empty;
  // defaulting to "equals (no value)" would silently hide every non-empty row.
  if (
    (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") &&
    !prop.config?.options?.length
  ) {
    return "is_not_empty";
  }
  return operatorsFor(prop)[0];
}

export function defaultValue(prop: DbProperty): unknown {
  if (prop.type === "checkbox") return true;
  if (prop.type === "number") return 0;
  if (prop.type === "unique_id") return 0;
  if (prop.type === "rollup" && NUMERIC_ROLLUP_FUNCTIONS.has(prop.config?.rollupFunction ?? "show_original")) return 0;
  if (prop.type === "select" || prop.type === "status" || prop.type === "multi_select") {
    return prop.config?.options?.[0]?.id ?? "";
  }
  return "";
}

function personFilterOptions({
  currentUserId,
  organizationProfiles,
  selectedValue,
  workspaceMembers,
}: {
  currentUserId: string;
  organizationProfiles: OrganizationProfile[];
  selectedValue: string;
  workspaceMembers: WorkspaceMember[];
}) {
  const options = new Map<string, { value: string; label: string }>();
  const add = (id: string | null | undefined, label?: string | null, email?: string | null) => {
    const value = id?.trim();
    if (!value || options.has(value)) return;
    const display = label?.trim() || email?.trim() || personLabel(value, currentUserId);
    options.set(value, { value, label: display });
  };

  add(currentUserId, personLabel(currentUserId, currentUserId));
  for (const member of workspaceMembers) add(member.userId, member.displayName, member.email);
  for (const profile of organizationProfiles) add(profile.userId, profile.displayName, profile.email);
  if (selectedValue && !options.has(selectedValue)) {
    options.set(selectedValue, { value: selectedValue, label: personLabel(selectedValue, currentUserId) });
  }

  return [
    { value: "", label: databaseViewLabels().choosePerson, disabled: true },
    ...Array.from(options.values()).slice(0, 80),
  ];
}
