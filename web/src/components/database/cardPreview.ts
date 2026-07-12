import type { DbProperty, Page } from "@/lib/types";
import { firstImageAttachment } from "./files";

export const CARD_PREVIEW_PAGE = "__page_cover";
export const CARD_PREVIEW_NONE = "__none";

export function isCoverProperty(prop: DbProperty) {
  return prop.type === "url" || prop.type === "files" || prop.type === "rich_text";
}

export function cardPreviewMode(coverProperty?: string) {
  return coverProperty ?? CARD_PREVIEW_PAGE;
}

export function hasCardPreview(coverProperty?: string) {
  return cardPreviewMode(coverProperty) !== CARD_PREVIEW_NONE;
}

function firstString(value: unknown): string {
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === "string") return value.trim();
  return "";
}

function isDisplayableCover(value: string) {
  return (
    value.startsWith("linear-gradient") ||
    value.startsWith("data:image/") ||
    value.startsWith("blob:") ||
    /^https?:\/\//i.test(value)
  );
}

export function cardCoverValue(row: Page, props: DbProperty[], coverProperty?: string) {
  const mode = cardPreviewMode(coverProperty);
  if (mode === CARD_PREVIEW_NONE) return "";
  if (mode === CARD_PREVIEW_PAGE) return isDisplayableCover(row.cover ?? "") ? (row.cover ?? "") : "";
  const prop = props.find((item) => item.id === mode);
  if (!prop) return "";
  if (prop.type === "files") {
    const file = firstImageAttachment(row.properties?.[prop.id]);
    return file && isDisplayableCover(file.url) ? file.url : "";
  }
  const value = firstString(row.properties?.[prop.id]);
  return isDisplayableCover(value) ? value : "";
}

export function coverBackground(value: string) {
  if (!value) return undefined;
  if (value.startsWith("linear-gradient")) return value;
  return `url("${value.replace(/"/g, '\\"')}")`;
}
