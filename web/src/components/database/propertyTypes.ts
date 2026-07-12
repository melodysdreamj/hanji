import { i18next } from "@/i18n";
import type { PropertyConfig, PropertyType } from "@/lib/types";

// Display order for the creatable property-type list. Labels are resolved
// lazily (at access time) so i18next has initialized before we read them.
const PROPERTY_TYPE_ORDER: PropertyType[] = [
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "person",
  "checkbox",
  "files",
  "relation",
  "rollup",
  "formula",
  "url",
  "email",
  "phone",
  "unique_id",
  "created_time",
  "last_edited_time",
  "created_by",
  "last_edited_by",
];

export const PROPERTY_TYPES: { type: PropertyType; label: string }[] = PROPERTY_TYPE_ORDER.map(
  (type) => ({
    type,
    get label() {
      return i18next.t(`propertyTypes:labels.${type}`);
    },
  })
);

export const CREATABLE_PROPERTY_TYPES = PROPERTY_TYPES;

export function propertyTypeLabel(type: PropertyType) {
  if (!PROPERTY_TYPE_ORDER.includes(type)) return type;
  return i18next.t(`propertyTypes:labels.${type}`);
}

export function localizedPropertyTypeLabel(type: PropertyType) {
  return i18next.t(`propertyTypes:labels.${type}`);
}

export function configForType(
  type: PropertyType,
  config: PropertyConfig | undefined,
  databaseId: string
): PropertyConfig | undefined {
  const displayConfig = {
    ...(config?.hideWhenEmpty !== undefined ? { hideWhenEmpty: config.hideWhenEmpty } : {}),
    ...(config?.hideInPagePanel !== undefined ? { hideInPagePanel: config.hideInPagePanel } : {}),
  };
  const withDisplayConfig = (next?: PropertyConfig): PropertyConfig | undefined => {
    const merged = { ...(next ?? {}), ...displayConfig };
    return Object.keys(merged).length ? merged : undefined;
  };
  if (type === "select" || type === "multi_select" || type === "status") {
    return withDisplayConfig({ options: config?.options ?? [] });
  }
  if (type === "number") return withDisplayConfig({ numberFormat: config?.numberFormat ?? "number" });
  if (type === "relation") {
    return withDisplayConfig({
      relationDatabaseId: config?.relationDatabaseId ?? databaseId,
      // Preserve the two-way pair link across config rebuilds (e.g. turn-into).
      ...(config?.relatedPropertyId ? { relatedPropertyId: config.relatedPropertyId } : {}),
    });
  }
  if (type === "rollup") {
    return withDisplayConfig({
      rollupRelationPropertyId: config?.rollupRelationPropertyId,
      rollupTargetPropertyId: config?.rollupTargetPropertyId,
      rollupFunction: config?.rollupFunction ?? "show_original",
    });
  }
  if (type === "formula") return withDisplayConfig({ formula: config?.formula ?? "" });
  return withDisplayConfig(undefined);
}
