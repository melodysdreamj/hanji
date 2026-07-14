"use client";

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageHref } from "@/lib/navigation";
import {
  spansToPlainText,
  type Block,
  type BlockType,
  type ButtonTemplateBlock,
  type DbTemplate,
  type DbView,
  type FilterGroup,
  type ViewType,
} from "@/lib/types";
import {
  BoardIcon,
  CalendarIcon,
  ChartIcon,
  FileText,
  GalleryIcon,
  ListIcon,
  TableIcon,
  TimelineIcon,
} from "@/icons/hanji";
import { parseInlineMarkdown } from "../editor/markdownPaste";
import { databaseViewLabels } from "./databaseViewLabels";
import { effectiveFilterGroup } from "./query";


export const NOTION_2023_VIEW_TYPES: { type: ViewType }[] = [
  { type: "table" },
  { type: "board" },
  { type: "list" },
  { type: "gallery" },
  { type: "calendar" },
  { type: "timeline" },
  { type: "chart" },
];

export const INLINE_DATABASE_TOOLBAR_MENU_EVENT = "hanji:open-inline-database-toolbar-menu";


export function viewTypeSettingsLabel(type: ViewType) {
  return databaseViewLabels().viewTypes[type] ?? type;
}

export function effectiveOpenPageIn(view?: DbView): "side" | "center" | "full" {
  if (!view) return "side";
  if (view.config?.openPageIn) return view.config.openPageIn;
  return view.type === "gallery" || view.type === "calendar"
    ? "center"
    : "side";
}

export function ViewTypeIcon({ type, size = 14 }: { type: ViewType; size?: number }) {
  if (type === "table") return <TableIcon size={size} aria-hidden="true" />;
  if (type === "board") return <BoardIcon size={size} aria-hidden="true" />;
  if (type === "list") return <ListIcon size={size} aria-hidden="true" />;
  if (type === "gallery") return <GalleryIcon size={size} aria-hidden="true" />;
  if (type === "calendar") return <CalendarIcon size={size} aria-hidden="true" />;
  if (type === "timeline") return <TimelineIcon size={size} aria-hidden="true" />;
  if (type === "chart") return <ChartIcon size={size} aria-hidden="true" />;
  return <TableIcon size={size} aria-hidden="true" />;
}


function isImageIcon(icon: string) {
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(icon);
}

export function TemplateIconGlyph({ icon, size = 14 }: { icon?: string; size?: number }) {
  const cleanIcon = icon?.trim();
  if (!cleanIcon) return <FileText size={size} aria-hidden="true" />;
  if (isImageIcon(cleanIcon)) return <img src={cleanIcon} alt="" />;
  return cleanIcon;
}

export const TOOLBAR_PROPERTY_DRAG = "application/x-hanji-toolbar-property";


export function onSegmentedOptionGroupKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.defaultPrevented) return;
  if (isComposingKeyEvent(e)) return;
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(e.key)) return;

  const options = Array.from(
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-segmented-option]:not(:disabled)")
  ).filter((option) => option.offsetParent !== null);
  if (options.length === 0) return;

  e.preventDefault();
  e.stopPropagation();

  const current = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLButtonElement>("[data-segmented-option]")
    : null;
  const currentIndex = current ? options.indexOf(current) : -1;
  let nextIndex = currentIndex >= 0 ? currentIndex : 0;

  if (e.key === "ArrowRight" || e.key === "ArrowDown") {
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % options.length : 0;
  } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
    nextIndex = currentIndex > 0 ? currentIndex - 1 : options.length - 1;
  } else if (e.key === "Home") {
    nextIndex = 0;
  } else if (e.key === "End") {
    nextIndex = options.length - 1;
  }

  options[nextIndex]?.focus();
  options[nextIndex]?.click();
}


export function databaseViewLink(databaseId: string, viewId: string) {
  if (typeof window === "undefined") return `${pageHref(databaseId)}?v=${encodeURIComponent(viewId)}`;
  const url = new URL(pageHref(databaseId), window.location.origin);
  url.searchParams.set("v", viewId);
  return url.toString();
}

const TEMPLATE_EDITOR_PAGE_PREFIX = "template:";

export function templateBodyPlaceholder() {
  return databaseViewLabels().templateBodyPlaceholder;
}

export function templateEditorPageId(templateId: string) {
  return `${TEMPLATE_EDITOR_PAGE_PREFIX}${templateId}`;
}

function cloneTemplateBlockContent(
  content?: ButtonTemplateBlock["content"]
): NonNullable<ButtonTemplateBlock["content"]> {
  const value = content ?? { rich: [] };
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as NonNullable<ButtonTemplateBlock["content"]>;
}

function templateEditorBlockId(pageId: string, path: number[]) {
  return `${pageId}:block:${path.join(".")}`;
}

export function templateBlocksToEditorBlocks(
  pageId: string,
  blocks: ButtonTemplateBlock[],
  now: string,
  parentId: string | null = null,
  path: number[] = []
): Block[] {
  return blocks.flatMap((block, index) => {
    const currentPath = [...path, index];
    const content = cloneTemplateBlockContent(block.content);
    const id = templateEditorBlockId(pageId, currentPath);
    const editorBlock: Block = {
      id,
      pageId,
      parentId,
      type: block.type,
      content,
      plainText: spansToPlainText(content.rich) || content.expression || content.url || content.fileName || "",
      position: index + 1,
      createdAt: now,
      updatedAt: now,
    };
    return [
      editorBlock,
      ...templateBlocksToEditorBlocks(pageId, block.children ?? [], now, id, currentPath),
    ];
  });
}

export function editorBlocksToTemplateBlocks(blocks: Block[], parentId: string | null = null): ButtonTemplateBlock[] {
  return blocks
    .filter((block) => (block.parentId ?? null) === parentId)
    .sort((a, b) => a.position - b.position)
    .map((block) => {
      const next: ButtonTemplateBlock = {
        type: block.type,
        content: cloneTemplateBlockContent(block.content),
      };
      const children = editorBlocksToTemplateBlocks(blocks, block.id);
      if (children.length > 0) next.children = children;
      return next;
    });
}

function makeTemplateBlock(type: BlockType = "paragraph", text = ""): ButtonTemplateBlock {
  if (type === "divider") return { type, content: { rich: [] } };
  if (type === "inline_database") return { type, content: { rich: [] } };
  if (type === "equation") return { type, content: { expression: text } };
  if (type === "code") return { type, content: { rich: text ? [{ text }] : [], language: "" } };
  if (type === "to_do") return { type, content: { rich: parseInlineMarkdown(text), checked: false } };
  if (type === "callout") return { type, content: { rich: parseInlineMarkdown(text), icon: "💡" } };
  return { type, content: { rich: parseInlineMarkdown(text) } };
}

export function templateBlocksOrDefault(blocks?: ButtonTemplateBlock[]) {
  return blocks && blocks.length > 0 ? blocks : [makeTemplateBlock()];
}

export function startsWithEmojiIcon(value: string) {
  return /^[\u{1F000}-\u{1FAFF}]/u.test(value.trim());
}

export function searchTerms(query: string) {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

export function templateNameValue(template: Pick<DbTemplate, "name">) {
  return template.name.trim();
}

export function templateTitleValue(template: Pick<DbTemplate, "title">) {
  const title = template.title?.trim() ?? "";
  return title ? (template.title ?? "") : "";
}

export function templateDisplayName(template: Pick<DbTemplate, "name" | "title">) {
  return templateNameValue(template) || templateTitleValue(template) || databaseViewLabels().newTemplate;
}

// --- Nested filter tree helpers (pure, immutable) -------------------------------
// A `path` is the chain of group indices from the root: [] = root group, [0] = its
// first sub-group, [0,2] = the third sub-group of that, and so on. Every transform
// clones the groups it touches so React state is never mutated in place.

/** Read the current tree, lazily migrating any existing flat filters into the root. */
export function readFilterTree(config: DbView["config"]): FilterGroup {
  return effectiveFilterGroup(config) ?? {
    conjunction: config?.filterConjunction === "or" ? "or" : "and",
    filters: config?.filters ?? [],
    groups: [],
  };
}

export function cloneViewConfigPart<T>(value: T): T {
  return value == null ? value : JSON.parse(JSON.stringify(value)) as T;
}

/** Count every leaf condition in the tree (used for the toolbar button badge). */
export function countLeaves(group: FilterGroup): number {
  let total = group.filters.length;
  for (const sub of group.groups ?? []) total += countLeaves(sub);
  return total;
}

export function placeViewTabMenu(trigger: HTMLElement, width: number): CSSProperties {
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const menuWidth = Math.max(220, Math.min(width, window.innerWidth - margin * 2));
  const preferredLeft = rect.left + menuWidth > window.innerWidth - margin
    ? rect.right - menuWidth
    : rect.left;
  const left = Math.min(
    Math.max(margin, preferredLeft),
    Math.max(margin, window.innerWidth - menuWidth - margin)
  );
  const top = Math.max(margin, Math.min(rect.bottom + 4, window.innerHeight - margin - 180));
  return {
    position: "fixed",
    top,
    left,
    width: menuWidth,
    maxWidth: `calc(100vw - ${margin * 2}px)`,
    maxHeight: Math.max(180, window.innerHeight - top - margin),
  };
}

/**
 * Return a new tree where the group at `path` is replaced by `fn(group)`. The path
 * and every ancestor are rebuilt with fresh objects/arrays; untouched branches are
 * shared by reference.
 */
export function updateGroupAtPath(
  root: FilterGroup,
  path: number[],
  fn: (group: FilterGroup) => FilterGroup
): FilterGroup {
  if (path.length === 0) return fn(root);
  const [index, ...rest] = path;
  const groups = root.groups ?? [];
  const child = groups[index];
  if (!child) return root;
  const nextChild = updateGroupAtPath(child, rest, fn);
  const nextGroups = groups.map((g, i) => (i === index ? nextChild : g));
  return { ...root, groups: nextGroups };
}
