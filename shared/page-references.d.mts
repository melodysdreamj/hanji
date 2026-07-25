export type PageReferenceKind = 'mention' | 'link';

export interface PageReferenceBlockLike {
  type?: unknown;
  content?: unknown;
}

export interface PageReferenceTarget {
  pageId: string;
  kind: PageReferenceKind;
}

export type PageReferenceHrefNormalizer = (href: unknown) => unknown;

export function pageIdFromPageHref(href: unknown): string | null;
export function pageReferenceTargets(
  block: PageReferenceBlockLike,
  normalizeHref?: PageReferenceHrefNormalizer,
): PageReferenceTarget[];
export function blockReferenceKind(
  block: PageReferenceBlockLike,
  targetPageId: string,
  normalizeHref?: PageReferenceHrefNormalizer,
): PageReferenceKind | null;
