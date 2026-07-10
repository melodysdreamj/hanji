import { spansToPlainText, type TextSpan } from "./types";

const TEXT_OPERATION_CONTEXT_CHARS = 24;
const MAX_TEXT_OPERATION_SPANS = 1000;
const MAX_TEXT_OPERATION_SPAN_CHARS = 20_000;

const MARK_KEYS: (keyof TextSpan)[] = [
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "color",
  "link",
  "commentId",
  "mention",
  "pageId",
  "date",
  "userId",
  "iconUrl",
];

export interface TextSpanOperation {
  afterText: string;
  beforeText: string;
  deleteCount: number;
  deletedText: string;
  insert: TextSpan[];
  prefixContext: string;
  start: number;
  suffixContext: string;
}

function sameMarks(a: TextSpan, b: TextSpan): boolean {
  return MARK_KEYS.every((key) => a[key] === b[key]);
}

function coalesce(spans: TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];
  for (const span of spans) {
    if (span.text === "") continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, span)) last.text += span.text;
    else out.push({ ...span });
  }
  return out;
}

function splitSpans(spans: TextSpan[], offset: number): [TextSpan[], TextSpan[]] {
  const before: TextSpan[] = [];
  const after: TextSpan[] = [];
  let acc = 0;
  for (const span of spans) {
    const len = span.text.length;
    if (acc >= offset) {
      after.push(span);
    } else if (acc + len <= offset) {
      before.push(span);
    } else {
      const cut = offset - acc;
      before.push({ ...span, text: span.text.slice(0, cut) });
      after.push({ ...span, text: span.text.slice(cut) });
    }
    acc += len;
  }
  return [coalesce(before), coalesce(after)];
}

function concatSpans(...parts: TextSpan[][]): TextSpan[] {
  return coalesce(parts.flat());
}

/**
 * Structural equality of two rich-text span arrays, ignoring representation
 * differences (adjacent same-mark runs, empty-text spans). Used to detect a
 * formatting-only remote edit — same plain text, different marks — so it isn't
 * silently dropped by a plain-text short-circuit.
 */
export function textSpansEqual(a?: readonly TextSpan[], b?: readonly TextSpan[]): boolean {
  const left = coalesce([...(a ?? [])]);
  const right = coalesce([...(b ?? [])]);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i].text !== right[i].text) return false;
    if (!sameMarks(left[i], right[i])) return false;
  }
  return true;
}

export function sanitizeTextSpans(value: unknown): TextSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .slice(0, MAX_TEXT_OPERATION_SPANS)
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const source = item as Record<string, unknown>;
      if (typeof source.text !== "string") return null;
      const span: TextSpan = { text: source.text.slice(0, MAX_TEXT_OPERATION_SPAN_CHARS) };
      if (source.bold === true) span.bold = true;
      if (source.italic === true) span.italic = true;
      if (source.underline === true) span.underline = true;
      if (source.strikethrough === true) span.strikethrough = true;
      if (source.code === true) span.code = true;
      if (typeof source.color === "string") span.color = source.color;
      if (typeof source.link === "string") span.link = source.link;
      if (typeof source.commentId === "string") span.commentId = source.commentId;
      if (
        source.mention === "page" ||
        source.mention === "date" ||
        source.mention === "person" ||
        source.mention === "external"
      ) {
        span.mention = source.mention;
      }
      if (typeof source.pageId === "string") span.pageId = source.pageId;
      if (typeof source.date === "string") span.date = source.date;
      if (typeof source.userId === "string") span.userId = source.userId;
      if (typeof source.iconUrl === "string") span.iconUrl = source.iconUrl;
      return span;
    })
    .filter((item): item is TextSpan => !!item);
}

export function createTextOperation(
  beforeSpans: TextSpan[],
  afterSpans: TextSpan[]
): TextSpanOperation | undefined {
  const beforeText = spansToPlainText(beforeSpans);
  const afterText = spansToPlainText(afterSpans);
  if (beforeText === afterText) return undefined;

  let start = 0;
  while (
    start < beforeText.length &&
    start < afterText.length &&
    beforeText[start] === afterText[start]
  ) {
    start += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeText.length - start &&
    suffix < afterText.length - start &&
    beforeText[beforeText.length - 1 - suffix] === afterText[afterText.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const deleteCount = beforeText.length - start - suffix;
  const insertLength = afterText.length - start - suffix;
  const [, afterStart] = splitSpans(afterSpans, start);
  const [insert] = splitSpans(afterStart, insertLength);

  return {
    afterText,
    beforeText,
    deleteCount,
    deletedText: beforeText.slice(start, start + deleteCount),
    insert,
    prefixContext: beforeText.slice(Math.max(0, start - TEXT_OPERATION_CONTEXT_CHARS), start),
    start,
    suffixContext: beforeText.slice(
      start + deleteCount,
      start + deleteCount + TEXT_OPERATION_CONTEXT_CHARS
    ),
  };
}

export function sanitizeTextSpanOperation(value: unknown): TextSpanOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.start !== "number" || typeof source.deleteCount !== "number") return undefined;
  if (!Number.isFinite(source.start) || !Number.isFinite(source.deleteCount)) return undefined;
  const insert = sanitizeTextSpans(source.insert);
  if (!insert) return undefined;
  const start = Math.max(0, Math.floor(source.start));
  const deleteCount = Math.max(0, Math.floor(source.deleteCount));
  const beforeText = typeof source.beforeText === "string" ? source.beforeText : "";
  const afterText = typeof source.afterText === "string" ? source.afterText : "";
  const deletedText = typeof source.deletedText === "string" ? source.deletedText : "";
  return {
    afterText,
    beforeText,
    deleteCount,
    deletedText,
    insert,
    prefixContext: typeof source.prefixContext === "string" ? source.prefixContext : "",
    start,
    suffixContext: typeof source.suffixContext === "string" ? source.suffixContext : "",
  };
}

function findAnchoredStart(currentText: string, operation: TextSpanOperation): number | null {
  if (currentText === operation.beforeText) return operation.start;

  const exactContext = `${operation.prefixContext}${operation.deletedText}${operation.suffixContext}`;
  if (exactContext) {
    const index = currentText.indexOf(exactContext);
    if (index >= 0 && currentText.indexOf(exactContext, index + 1) < 0) {
      return index + operation.prefixContext.length;
    }
  }

  if (operation.deleteCount === 0) {
    const insertAnchor = `${operation.prefixContext}${operation.suffixContext}`;
    if (insertAnchor) {
      const index = currentText.indexOf(insertAnchor);
      if (index >= 0 && currentText.indexOf(insertAnchor, index + 1) < 0) {
        return index + operation.prefixContext.length;
      }
    }
  }

  if (operation.prefixContext && operation.suffixContext) {
    const prefixIndex = currentText.indexOf(operation.prefixContext);
    if (prefixIndex >= 0 && currentText.indexOf(operation.prefixContext, prefixIndex + 1) < 0) {
      const start = prefixIndex + operation.prefixContext.length;
      const suffixIndex = currentText.indexOf(operation.suffixContext, start);
      if (suffixIndex >= 0) return start;
    }
  }

  if (operation.prefixContext) {
    const index = currentText.indexOf(operation.prefixContext);
    if (index >= 0 && currentText.indexOf(operation.prefixContext, index + 1) < 0) {
      return index + operation.prefixContext.length;
    }
  }

  if (operation.suffixContext) {
    const index = currentText.indexOf(operation.suffixContext);
    if (index >= 0 && currentText.indexOf(operation.suffixContext, index + 1) < 0) {
      return index;
    }
  }

  return null;
}

export function applyTextOperationToSpans(
  currentSpans: TextSpan[],
  operation: TextSpanOperation
): TextSpan[] | null {
  const currentText = spansToPlainText(currentSpans);
  const start = findAnchoredStart(currentText, operation);
  if (start === null) return null;
  if (currentText.slice(start, start + operation.deleteCount) !== operation.deletedText) {
    return null;
  }

  const [head, deleteAndTail] = splitSpans(currentSpans, start);
  const [, tail] = splitSpans(deleteAndTail, operation.deleteCount);
  return concatSpans(head, operation.insert, tail);
}
