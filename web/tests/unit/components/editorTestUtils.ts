// Shared helpers for editor/database component tests: jsdom gap-fills plus
// block/view seeding on top of storeTestUtils. Test files must still declare
// their own `vi.mock("@/lib/edgebase", ...)` before importing this module.
import { useStore } from "@/lib/store";
import type { Block, DbView } from "@/lib/types";

// ── jsdom gap-fills ──────────────────────────────────────────────────
// jsdom 29 has no HTMLElement.innerText; the editor reads it when deciding
// whether a slash/mention trigger precedes the caret. textContent is an
// adequate stand-in for the plain single-line spans these tests exercise.
if (typeof HTMLElement !== "undefined") {
  const proto = HTMLElement.prototype as HTMLElement & { innerText?: string };
  const existing = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "innerText");
  if (!existing) {
    Object.defineProperty(proto, "innerText", {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent ?? "";
      },
      set(this: HTMLElement, value: string) {
        this.textContent = value;
      },
    });
  }
}

// jsdom Ranges have no layout: menu anchoring reads the caret rect.
if (typeof Range !== "undefined" && !Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => {
    const list = [] as unknown as DOMRectList;
    return list;
  };
}

// DatabaseView calls window.matchMedia unconditionally when opening rows.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

const FIXTURE_NOW = new Date().toISOString();

// ── factories & seeding ──────────────────────────────────────────────
export function makeBlock(
  pageId: string,
  overrides: Partial<Block> & { id: string }
): Block {
  return {
    pageId,
    parentId: null,
    type: "paragraph",
    content: { rich: [] },
    position: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function textBlock(
  pageId: string,
  id: string,
  text: string,
  overrides: Partial<Block> = {}
): Block {
  return makeBlock(pageId, {
    id,
    content: { rich: text ? [{ text }] : [], ...(overrides.content ?? {}) },
    plainText: text,
    ...overrides,
  });
}

/** Seeds page blocks and marks the page loaded so `loadBlocks` no-ops. */
export function seedBlocks(pageId: string, blocks: Block[]) {
  useStore.setState((s) => ({
    blocksByPage: {
      ...s.blocksByPage,
      [pageId]: [...blocks].sort((a, b) => a.position - b.position),
    },
    loadedBlockPages: new Set(s.loadedBlockPages).add(pageId),
  }));
}

export function makeView(
  dbId: string,
  overrides: Partial<DbView> & { id: string }
): DbView {
  return {
    databaseId: dbId,
    name: overrides.id,
    type: "table",
    position: 0,
    createdAt: FIXTURE_NOW,
    updatedAt: FIXTURE_NOW,
    ...overrides,
  };
}

export function seedDbViews(dbId: string, views: DbView[]) {
  useStore.setState((s) => ({ viewsByDb: { ...s.viewsByDb, [dbId]: views } }));
}

// ── selection helpers ────────────────────────────────────────────────
/** Places a collapsed caret at `offset` characters into the element's text. */
export function placeCaretAt(el: HTMLElement, offset: number) {
  const doc = el.ownerDocument;
  const range = doc.createRange();
  if (el.childNodes.length === 0) {
    range.setStart(el, 0);
  } else {
    let remaining = offset;
    let placed = false;
    const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        placed = true;
        break;
      }
      remaining -= length;
    }
    if (!placed) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
  }
  range.collapse(true);
  const selection = el.ownerDocument.defaultView?.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** clipboardData stub good enough for the editor paste handlers. */
export function clipboardWithText(text: string, html = "") {
  return {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain" ? text : type === "text/html" ? html : "",
      files: [] as File[],
    },
  };
}
