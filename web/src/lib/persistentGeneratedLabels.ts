import { i18next } from "@/i18n";
import { newId } from "@/lib/ids";

export type ProductLocale = "en" | "ko";

type Translate = (key: string, options?: Record<string, unknown>) => unknown;
type PropertyNameLike = { name: string };

function translated(t: Translate, key: string, options?: Record<string, unknown>) {
  return String(t(key, options));
}

export function productLocaleFromLanguage(language?: string | null): ProductLocale {
  return language?.toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function persistentGeneratedLabels(t: Translate) {
  return {
    untitled: translated(t, "common:labels.untitled"),
    importedDatabase: translated(t, "common:generated.importedDatabase"),
    uploadedFile: translated(t, "common:generated.uploadedFile"),
    image: translated(t, "common:generated.image"),
    propertyNames: {
      name: translated(t, "common:generated.propertyNames.name"),
      status: translated(t, "common:generated.propertyNames.status"),
      select: translated(t, "common:generated.propertyNames.select"),
      date: translated(t, "common:generated.propertyNames.date"),
    },
    statusOptions: {
      todo: translated(t, "common:generated.statusOptions.todo"),
      doing: translated(t, "common:generated.statusOptions.doing"),
      done: translated(t, "common:generated.statusOptions.done"),
    },
    selectOptions: {
      first: translated(t, "common:generated.selectOptions.first"),
      second: translated(t, "common:generated.selectOptions.second"),
    },
    viewNames: {
      table: translated(t, "common:generated.viewNames.table"),
    },
    columnName(number: number) {
      return translated(t, "common:generated.columnName", { number });
    },
    copyName(name: string) {
      return translated(t, "common:generated.copyName", { name });
    },
  };
}

export function activePersistentGeneratedLabels() {
  return persistentGeneratedLabels((key, options) => i18next.t(key, options));
}

/** Labels persisted when a canonical Markdown/HTML command omits its content. */
export function activePastedBlockLabels() {
  const t = (key: string) => String(i18next.t(key));
  return {
    linkToPage: t("blocks:defs.link_to_page.label"),
    file: t("blocks:defs.file.label"),
    tableOfContents: t("blocks:defs.table_of_contents.label"),
    breadcrumb: t("blocks:defs.breadcrumb.label"),
    syncedBlock: t("blocks:defs.synced_block.label"),
    tabs: t("blocks:defs.tab.label"),
    newButton: t("blockItem:button.newButton"),
    newTask: t("blockItem:button.newTask"),
  };
}

/** A shared, locale-aware and collision-free property duplication name. */
export function nextPropertyCopyName(
  properties: PropertyNameLike[],
  name: string,
  t: Translate,
) {
  const labels = persistentGeneratedLabels(t);
  const base = labels.copyName(name.trim() || labels.untitled);
  const names = new Set(properties.map((property) => property.name.trim().toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let number = 2; number < 1000; number += 1) {
    const candidate = `${base} ${number}`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${newId().slice(0, 4)}`;
}
