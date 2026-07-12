/**
 * Read-only compatibility for database filters persisted before the Hanji
 * namespace migration. New filters must always use the canonical export.
 */
export const HANJI_CURRENT_PAGE_FILTER_KIND = "hanji.current_page";

/** @deprecated Read-only migration fixture; never persist this value. */
export const LEGACY_CURRENT_PAGE_FILTER_KIND_READ_ONLY = "notionlike.current_page";

export function isHanjiCurrentPageFilterKind(value: unknown) {
  return (
    value === HANJI_CURRENT_PAGE_FILTER_KIND ||
    value === LEGACY_CURRENT_PAGE_FILTER_KIND_READ_ONLY
  );
}
