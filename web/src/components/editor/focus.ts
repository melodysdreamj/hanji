// Module-level registry of editable elements (page title + each block), so
// cross-element caret moves (Enter/Backspace/Arrows, title→first block) work
// without prop drilling.

const registry = new Map<string, HTMLElement>();

export function registerEditable(key: string, el: HTMLElement | null) {
  if (el) registry.set(key, el);
  else registry.delete(key);
}

export function getEditable(key: string): HTMLElement | undefined {
  return registry.get(key);
}

type CaretPos = "start" | "end" | number;

function cssEscape(value: string) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

export function placeCaret(el: HTMLElement, pos: CaretPos = "end") {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  if (el.childNodes.length === 0) {
    range.setStart(el, 0);
    range.collapse(true);
  } else if (pos === "start") {
    range.setStart(el, 0);
    range.collapse(true);
  } else if (pos === "end") {
    range.selectNodeContents(el);
    range.collapse(false);
  } else {
    // place at character offset, walking across nested mark elements
    const safePos = Math.max(0, pos);
    const textLength = el.textContent?.length ?? 0;
    const found = safePos >= textLength ? null : nodeAtOffset(el, safePos);
    if (found) {
      range.setStart(found.node, found.offset);
      range.collapse(true);
    } else {
      range.selectNodeContents(el);
      range.collapse(false);
    }
  }
  sel.removeAllRanges();
  sel.addRange(range);
}

export function focusEditable(
  key: string,
  pos: CaretPos = "end",
  attempts = 12
): boolean {
  const el = registry.get(key);
  if (el) {
    // Synchronous when the element is already mounted — avoids a frame gap where
    // fast typing would land in the previously-focused element (e.g. the title).
    placeCaret(el, pos);
    return true;
  }
  if (attempts <= 0) return false;
  // Just-created block not registered yet — retry on the next frame.
  requestAnimationFrame(() => focusEditable(key, pos, attempts - 1));
  return false;
}

function activeEditableBelongsToBlock(key: string) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const registered = registry.get(key);
  if (registered && active !== registered && !registered.contains(active)) return false;
  const activeBlock = active.closest<HTMLElement>("[data-block-id]");
  const activeEditable = active.closest("[data-rt-editable='true']");
  return activeBlock?.dataset.blockId === key && !!activeEditable;
}

export function focusEditableSettled(
  key: string,
  pos: CaretPos = "end",
  attempts = 12
) {
  focusEditable(key, pos, attempts);
  requestAnimationFrame(() => {
    if (activeEditableBelongsToBlock(key)) return;
    focusEditable(key, pos, attempts);
  });
}

function blockOwnRow(blockId: string) {
  const group = document.querySelector<HTMLElement>(
    `[data-block-id="${cssEscape(blockId)}"]`
  );
  return group?.querySelector<HTMLElement>(":scope > [data-type]") ?? group;
}

export function focusBlockControl(
  blockId: string,
  selector: string,
  attempts = 12
): boolean {
  const row = blockOwnRow(blockId);
  const target = row?.querySelector<HTMLElement>(selector);
  if (target) {
    target.focus();
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    ) {
      target.select();
    } else if (target.isContentEditable) {
      placeCaret(target, "end");
    }
    return true;
  }
  if (attempts <= 0) return false;
  requestAnimationFrame(() => focusBlockControl(blockId, selector, attempts - 1));
  return false;
}

export function focusBlockControlSettled(
  blockId: string,
  selector: string,
  attempts = 12
) {
  focusBlockControl(blockId, selector, attempts);
  requestAnimationFrame(() => {
    const active = document.activeElement;
    const activeBlock =
      active instanceof HTMLElement ? active.closest<HTMLElement>("[data-block-id]") : null;
    if (activeBlock?.dataset.blockId === blockId) return;
    focusBlockControl(blockId, selector, attempts);
  });
}

/** Find the descendant text node + local offset for a plain-text character offset. */
function nodeAtOffset(
  root: Node,
  pos: number
): { node: Node; offset: number } | null {
  let remaining = pos;
  let last: Text | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n = walker.nextNode() as Text | null;
  while (n) {
    const len = n.textContent?.length ?? 0;
    if (remaining < len) return { node: n, offset: remaining };
    remaining -= len;
    last = n;
    n = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: last.textContent?.length ?? 0 };
  return null;
}

/** Caret offset within an editable element (collapsed selection). */
export function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.focusNode!, sel.focusOffset);
  return range.toString().length;
}

export function hasCollapsedSelection(el: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  return range.collapsed && el.contains(range.startContainer) && el.contains(range.endContainer);
}

export function selectionOffsetsIn(el: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;

  const startRange = document.createRange();
  startRange.selectNodeContents(el);
  startRange.setEnd(range.startContainer, range.startOffset);

  const endRange = document.createRange();
  endRange.selectNodeContents(el);
  endRange.setEnd(range.endContainer, range.endOffset);

  const start = startRange.toString().length;
  const end = endRange.toString().length;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

export function selectEditableRange(el: HTMLElement, start: number, end: number = start) {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, end);
  if (safeStart === safeEnd) {
    placeCaret(el, safeStart);
    return;
  }
  el.focus();
  const rangeStart = nodeAtOffset(el, safeStart);
  const rangeEnd = nodeAtOffset(el, safeEnd);
  const sel = window.getSelection();
  if (!rangeStart || !rangeEnd || !sel) return;
  const range = document.createRange();
  range.setStart(rangeStart.node, rangeStart.offset);
  range.setEnd(rangeEnd.node, rangeEnd.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function isEditableFullySelected(el: HTMLElement): boolean {
  const length = el.textContent?.length ?? 0;
  if (length === 0) return false;
  const offsets = selectionOffsetsIn(el);
  return !!offsets && offsets.start === 0 && offsets.end >= length;
}

export function selectEditableContents(el: HTMLElement) {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

export function isCaretAtStart(el: HTMLElement): boolean {
  return hasCollapsedSelection(el) && caretOffset(el) === 0;
}

export function isCaretAtEnd(el: HTMLElement): boolean {
  return hasCollapsedSelection(el) && caretOffset(el) === (el.textContent?.length ?? 0);
}
