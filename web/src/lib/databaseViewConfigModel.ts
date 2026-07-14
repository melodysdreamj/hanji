import type { FilterGroup, ViewConfig, ViewFilter } from "./types";

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function omitRecordKey<T>(record: Record<string, T> | undefined, key: string) {
  if (!record || !(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return Object.keys(next).length ? next : undefined;
}

function remapRecordKeys<T>(record: Record<string, T> | undefined, ids: Map<string, string>) {
  if (!record) return record;
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    next[ids.get(key) ?? key] = value;
  }
  return next;
}

function remapFilterGroup(group: FilterGroup, ids: Map<string, string>): FilterGroup {
  return {
    ...group,
    filters: group.filters.map((filter) => ({
      ...filter,
      propertyId: ids.get(filter.propertyId) ?? filter.propertyId,
    })),
    groups: group.groups?.map((sub) => remapFilterGroup(sub, ids)),
  };
}

function filterGroupHasTerms(group: FilterGroup) {
  return group.filters.length > 0 || (group.groups ?? []).some(filterGroupHasTerms);
}

function filterGroupWithoutProperty(
  group: FilterGroup,
  propertyId: string
): FilterGroup | undefined {
  const next: FilterGroup = {
    ...group,
    filters: group.filters.filter((filter) => filter.propertyId !== propertyId),
    groups: group.groups
      ?.map((sub) => filterGroupWithoutProperty(sub, propertyId))
      .filter((sub): sub is FilterGroup => !!sub && filterGroupHasTerms(sub)),
  };
  return filterGroupHasTerms(next) ? next : undefined;
}

function quickFilterWithoutProperty(
  filter: ViewFilter | FilterGroup,
  propertyId: string
): ViewFilter | FilterGroup | undefined {
  if ("propertyId" in filter) return filter.propertyId === propertyId ? undefined : filter;
  return filterGroupWithoutProperty(filter, propertyId);
}

export function viewConfigWithoutProperty(config: ViewConfig | undefined, propertyId: string) {
  const next: ViewConfig = { ...(config ?? {}) };
  if (next.visibleProperties) {
    next.visibleProperties = next.visibleProperties.filter((id) => id !== propertyId);
  }
  if (next.hiddenProperties) {
    next.hiddenProperties = next.hiddenProperties.filter((id) => id !== propertyId);
  }
  if (next.propertyOrder) {
    next.propertyOrder = next.propertyOrder.filter((id) => id !== propertyId);
  }
  if (next.rowPagePropertyOrder) {
    next.rowPagePropertyOrder = next.rowPagePropertyOrder.filter((id) => id !== propertyId);
  }
  next.propertyWidths = omitRecordKey(next.propertyWidths, propertyId);
  next.tableCalculations = omitRecordKey(next.tableCalculations, propertyId);
  if (next.filters) next.filters = next.filters.filter((filter) => filter.propertyId !== propertyId);
  if (next.filterGroup) next.filterGroup = filterGroupWithoutProperty(next.filterGroup, propertyId);
  if (next.quickFilters) {
    next.quickFilters = next.quickFilters
      .map((filter) => quickFilterWithoutProperty(filter, propertyId))
      .filter((filter): filter is ViewFilter | FilterGroup => !!filter);
  }
  if (next.sorts) next.sorts = next.sorts.filter((sort) => sort.propertyId !== propertyId);
  if (next.wrappedColumns) next.wrappedColumns = next.wrappedColumns.filter((id) => id !== propertyId);
  if (next.groupBy === propertyId) next.groupBy = undefined;
  if (next.calendarBy === propertyId) next.calendarBy = undefined;
  if (next.timelineBy === propertyId) next.timelineBy = undefined;
  if (next.timelineEndBy === propertyId) next.timelineEndBy = undefined;
  if (next.dependencyProperty === propertyId) next.dependencyProperty = undefined;
  if (next.coverProperty === propertyId) next.coverProperty = undefined;
  if (next.subGroupBy === propertyId) next.subGroupBy = undefined;
  if (next.chartGroupBy === propertyId) next.chartGroupBy = undefined;
  if (next.chartAggregateBy === propertyId) next.chartAggregateBy = undefined;
  if (next.templateLinkedRelationPropertyId === propertyId) {
    next.templateLinkedRelationPropertyId = undefined;
  }
  return next;
}

export function viewConfigWithoutFilterProperty(
  config: ViewConfig | undefined,
  propertyId: string
) {
  const next: ViewConfig = { ...(config ?? {}) };
  if (next.filters) next.filters = next.filters.filter((filter) => filter.propertyId !== propertyId);
  if (next.filterGroup) next.filterGroup = filterGroupWithoutProperty(next.filterGroup, propertyId);
  return next;
}

export function remapViewConfigPropertyIds(
  config: ViewConfig | undefined,
  ids: Map<string, string>
) {
  const next: ViewConfig = cloneJson(config ?? {});
  if (next.visibleProperties) next.visibleProperties = next.visibleProperties.map((id) => ids.get(id) ?? id);
  if (next.propertyOrder) next.propertyOrder = next.propertyOrder.map((id) => ids.get(id) ?? id);
  next.propertyWidths = remapRecordKeys(next.propertyWidths, ids);
  next.tableCalculations = remapRecordKeys(next.tableCalculations, ids);
  if (next.filters) {
    next.filters = next.filters.map((filter) => ({
      ...filter,
      propertyId: ids.get(filter.propertyId) ?? filter.propertyId,
    }));
  }
  if (next.filterGroup) next.filterGroup = remapFilterGroup(next.filterGroup, ids);
  if (next.sorts) {
    next.sorts = next.sorts.map((sort) => ({
      ...sort,
      propertyId: ids.get(sort.propertyId) ?? sort.propertyId,
    }));
  }
  if (next.wrappedColumns) next.wrappedColumns = next.wrappedColumns.map((id) => ids.get(id) ?? id);
  if (next.groupBy) next.groupBy = ids.get(next.groupBy) ?? next.groupBy;
  if (next.calendarBy) next.calendarBy = ids.get(next.calendarBy) ?? next.calendarBy;
  if (next.timelineBy) next.timelineBy = ids.get(next.timelineBy) ?? next.timelineBy;
  if (next.timelineEndBy) next.timelineEndBy = ids.get(next.timelineEndBy) ?? next.timelineEndBy;
  if (next.dependencyProperty) {
    next.dependencyProperty = ids.get(next.dependencyProperty) ?? next.dependencyProperty;
  }
  if (next.coverProperty) next.coverProperty = ids.get(next.coverProperty) ?? next.coverProperty;
  if (next.subGroupBy) next.subGroupBy = ids.get(next.subGroupBy) ?? next.subGroupBy;
  return next;
}

export function viewConfigChanged(left: unknown, right: unknown) {
  return JSON.stringify(left ?? {}) !== JSON.stringify(right ?? {});
}
