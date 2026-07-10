"use client";

import type { IconType, Page } from "./types";

export const PAGE_ROOM_MUTATION_SIGNAL = "page_mutation";
export const PAGE_ROOM_MUTATION_EVENT = "notionlike:page-room-mutation";
export const PAGE_ROOM_MUTATION_RECEIVED_EVENT = "notionlike:page-room-mutation-received";
export const LOCAL_DATABASE_MUTATION_EVENT = "notionlike:local-database-mutation";

export type PageRoomMutationKind =
  | "page_meta_changed"
  | "database_rows_changed"
  | "database_schema_changed"
  | "database_views_changed"
  | "database_templates_changed"
  | "block_structure_changed"
  | "comments_changed"
  | "permissions_changed";

export type PageMetaMutationPatch = Partial<
  Pick<
    Page,
    | "backlinksDisplay"
    | "cover"
    | "coverPosition"
    | "font"
    | "fullWidth"
    | "icon"
    | "iconType"
    | "isFavorite"
    | "isLocked"
    | "lastEditedBy"
    | "pageCommentsDisplay"
    | "smallText"
    | "title"
    | "updatedAt"
    | "verificationExpiresAt"
    | "verifiedAt"
    | "verifiedBy"
  >
>;

export interface PageRoomMutationChange {
  blockIds?: string[];
  databaseId?: string;
  kind: PageRoomMutationKind;
  pageId: string;
  patch?: PageMetaMutationPatch;
  propertyIds?: string[];
  reason?: string;
  revision?: number;
  rowIds?: string[];
  targetPageId?: string;
  updatedAt?: string;
  viewIds?: string[];
}

export interface PageRoomMutationReceived extends PageRoomMutationChange {
  label?: string;
  memberId?: string;
  receivedAt: number;
  userId: string;
}

export interface LocalDatabaseMutationChange
  extends Omit<PageRoomMutationChange, "kind" | "pageId"> {
  databaseId: string;
  kind:
    | "database_rows_changed"
    | "database_schema_changed"
    | "database_views_changed"
    | "database_templates_changed";
}

const PAGE_META_KEYS = new Set<keyof PageMetaMutationPatch>([
  "backlinksDisplay",
  "cover",
  "coverPosition",
  "font",
  "fullWidth",
  "icon",
  "iconType",
  "isFavorite",
  "isLocked",
  "lastEditedBy",
  "pageCommentsDisplay",
  "smallText",
  "title",
  "updatedAt",
  "verificationExpiresAt",
  "verifiedAt",
  "verifiedBy",
]);

function isIconType(value: unknown): value is IconType {
  return value === "emoji" || value === "image" || value === "none";
}

export function pageMetaMutationPatch(patch: Partial<Page>): PageMetaMutationPatch | undefined {
  const out: PageMetaMutationPatch = {};
  for (const [key, value] of Object.entries(patch) as [keyof PageMetaMutationPatch, unknown][]) {
    if (!PAGE_META_KEYS.has(key)) continue;
    if (key === "iconType" && !isIconType(value)) continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function publishPageRoomMutation(change: PageRoomMutationChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PageRoomMutationChange>(PAGE_ROOM_MUTATION_EVENT, { detail: change }));
}

export function publishLocalDatabaseMutation(change: LocalDatabaseMutationChange) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<LocalDatabaseMutationChange>(LOCAL_DATABASE_MUTATION_EVENT, { detail: change }),
  );
}
