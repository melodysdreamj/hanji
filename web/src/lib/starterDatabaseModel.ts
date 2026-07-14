import type { createDatabaseRemote } from "./edgebase";
import { i18next } from "@/i18n";
import { newId } from "./ids";
import { activePersistentGeneratedLabels } from "./persistentGeneratedLabels";
import type { DbProperty, DbView, PropertyType, ViewConfig, ViewType } from "./types";

export type StarterDatabaseViewType = Extract<
  ViewType,
  "table" | "board" | "list" | "gallery" | "calendar" | "timeline"
>;

function cloneJson<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export function optimisticStarterDatabaseSchema(
  databaseId: string,
  viewType: StarterDatabaseViewType,
  rawProperties: Parameters<typeof createDatabaseRemote>[0]["properties"]
) {
  const labels = activePersistentGeneratedLabels();
  const input = rawProperties ?? [
    { name: labels.propertyNames.name, type: "title" as const, position: 1 },
    {
      name: labels.propertyNames.status,
      type: "status" as const,
      position: 2,
      config: {
        options: [
          { id: newId(), name: labels.statusOptions.todo, color: "gray" },
          { id: newId(), name: labels.statusOptions.doing, color: "blue" },
          { id: newId(), name: labels.statusOptions.done, color: "green" },
        ],
      },
    },
    {
      name: labels.propertyNames.select,
      type: "multi_select" as const,
      position: 3,
      config: {
        options: [
          { id: newId(), name: labels.selectOptions.first, color: "purple" },
          { id: newId(), name: labels.selectOptions.second, color: "red" },
        ],
      },
    },
  ];
  const properties: DbProperty[] = input.map((property, index) => ({
    id: property.id || newId(),
    databaseId,
    name: property.name?.trim() || labels.columnName(index + 1),
    type: (property.type ?? "rich_text") as PropertyType,
    description: property.description,
    config: property.config ? cloneJson(property.config) : undefined,
    position: property.position ?? index + 1,
  }));
  if (!properties.some((property) => property.type === "title")) {
    properties.unshift({
      id: newId(),
      databaseId,
      name: labels.propertyNames.name,
      type: "title",
      position: 1,
    });
  }
  if (
    (viewType === "calendar" || viewType === "timeline") &&
    !properties.some((property) => property.type === "date")
  ) {
    properties.push({
      id: newId(),
      databaseId,
      name: labels.propertyNames.date,
      type: "date",
      position: properties.length + 1,
    });
  }
  const config: ViewConfig = {
    propertyOrder: properties.map((property) => property.id),
    visibleProperties: properties.map((property) => property.id),
  };
  if (viewType === "board") {
    config.groupBy = properties.find(
      (property) => property.type === "status" || property.type === "select"
    )?.id;
  }
  const dateProperty = properties.find((property) => property.type === "date");
  if (viewType === "calendar") config.calendarBy = dateProperty?.id;
  if (viewType === "timeline") {
    config.timelineBy = dateProperty?.id;
    config.timelineZoom = "month";
  }
  if (viewType === "gallery") config.cardSize = "medium";
  const view: DbView = {
    id: newId(),
    databaseId,
    name: i18next.t(`databaseView:viewTypes.${viewType}`),
    type: viewType,
    position: 1,
    config,
  };
  return { properties, view };
}
