import { pickLabels } from "@/lib/i18n";
import type { PropertyConfig, PropertyType } from "@/lib/types";

export const PROPERTY_TYPES: { type: PropertyType; label: string }[] = [
  { type: "rich_text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "status", label: "Status" },
  { type: "date", label: "Date" },
  { type: "person", label: "Person" },
  { type: "checkbox", label: "Checkbox" },
  { type: "files", label: "Files & media" },
  { type: "relation", label: "Relation" },
  { type: "rollup", label: "Rollup" },
  { type: "formula", label: "Formula" },
  { type: "url", label: "URL" },
  { type: "email", label: "Email" },
  { type: "phone", label: "Phone" },
  { type: "unique_id", label: "ID" },
  { type: "created_time", label: "Created time" },
  { type: "last_edited_time", label: "Last edited time" },
  { type: "created_by", label: "Created by" },
  { type: "last_edited_by", label: "Last edited by" },
];

export const CREATABLE_PROPERTY_TYPES = PROPERTY_TYPES;

export function propertyTypeLabel(type: PropertyType) {
  return PROPERTY_TYPES.find((item) => item.type === type)?.label ?? type;
}

const PROPERTY_TYPE_LABELS: { en: Record<PropertyType, string>; ko: Record<PropertyType, string> } = {
  en: {
    title: "Title",
    rich_text: "Text",
    number: "Number",
    select: "Select",
    multi_select: "Multi-select",
    status: "Status",
    date: "Date",
    person: "Person",
    files: "Files & media",
    checkbox: "Checkbox",
    url: "URL",
    email: "Email",
    phone: "Phone",
    formula: "Formula",
    relation: "Relation",
    rollup: "Rollup",
    created_time: "Created time",
    created_by: "Created by",
    last_edited_time: "Last edited time",
    last_edited_by: "Last edited by",
    unique_id: "ID",
  },
  ko: {
    title: "이름",
    rich_text: "텍스트",
    number: "숫자",
    select: "선택",
    multi_select: "다중 선택",
    status: "상태",
    date: "날짜",
    person: "사람",
    files: "파일과 미디어",
    checkbox: "체크박스",
    url: "URL",
    email: "이메일",
    phone: "전화번호",
    formula: "수식",
    relation: "관계형",
    rollup: "롤업",
    created_time: "생성 일시",
    created_by: "생성자",
    last_edited_time: "최종 편집 일시",
    last_edited_by: "최종 편집자",
    unique_id: "고유 ID",
  },
};

export function localizedPropertyTypeLabel(type: PropertyType) {
  return pickLabels(PROPERTY_TYPE_LABELS)[type] ?? propertyTypeLabel(type);
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
    return withDisplayConfig({ relationDatabaseId: config?.relationDatabaseId ?? databaseId });
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
