import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { safeUrl } from "./richtext";
import { parsePastedMarkdown, type PastedBlock } from "./markdownPaste";
import type { BlockType, TextSpan } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";

export function shortcutBlockType(e: ReactKeyboardEvent<HTMLElement>): BlockType | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  const key = e.key.toLowerCase();
  const digit = e.code.startsWith("Digit") ? e.code.slice("Digit".length) : key;
  const hasTypeShortcutModifier = e.altKey || (e.ctrlKey && !e.metaKey && e.shiftKey);
  if (hasTypeShortcutModifier) {
    if (digit === "0") return "paragraph";
    if (digit === "1") return "heading_1";
    if (digit === "2") return "heading_2";
    if (digit === "3") return "heading_3";
    if (digit === "4") return "to_do";
    if (digit === "5") return "bulleted_list_item";
    if (digit === "6") return "numbered_list_item";
    if (digit === "7") return "toggle";
    if (digit === "8") return "code";
    if (digit === "9") return "child_page";
  }
  return null;
}

export function printableTextKey(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.metaKey || e.ctrlKey || e.altKey) return "";
  if (e.key.length !== 1) return "";
  if (e.key === " ") return "";
  return e.key;
}

export type BlockTextMark = "bold" | "italic" | "underline" | "strikethrough" | "code";

export function shortcutTextMark(e: ReactKeyboardEvent<HTMLElement>): BlockTextMark | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (e.shiftKey) {
    if (key === "s" || key === "x") return "strikethrough";
    return null;
  }
  if (key === "b") return "bold";
  if (key === "i") return "italic";
  if (key === "u") return "underline";
  if (key === "e") return "code";
  return null;
}

export type InlineMarkdownMark = "bold" | "italic" | "strikethrough" | "code";

const TYPED_MARKDOWN_BLOCK_TYPES: Set<BlockType> = new Set([
  "image",
  "video",
  "audio",
  "embed",
  "file",
  "bookmark",
  "divider",
  "equation",
]);

const INLINE_MARKDOWN_SHORTCUTS: {
  open: string;
  close: string;
  mark: InlineMarkdownMark;
}[] = [
  { open: "**", close: "**", mark: "bold" },
  { open: "__", close: "__", mark: "bold" },
  { open: "~~", close: "~~", mark: "strikethrough" },
  { open: "`", close: "`", mark: "code" },
  { open: "~", close: "~", mark: "strikethrough" },
  { open: "*", close: "*", mark: "italic" },
  { open: "_", close: "_", mark: "italic" },
];

const INLINE_SYMBOL_SHORTCUTS = [
  { trigger: "->", replacement: "→" },
  { trigger: "<-", replacement: "←" },
] as const;


export function findInlineSymbolShortcut(textBeforeCaret: string) {
  for (const shortcut of INLINE_SYMBOL_SHORTCUTS) {
    if (!textBeforeCaret.endsWith(shortcut.trigger)) continue;
    const start = textBeforeCaret.length - shortcut.trigger.length;
    if (isEscaped(textBeforeCaret, start)) continue;
    if (hasOpenInlineCodeDelimiter(textBeforeCaret, start)) continue;
    return { ...shortcut, start };
  }
  return null;
}

export function inlineSymbolReplacementSpan(spans: TextSpan[], text: string): TextSpan {
  const source = [...spans].reverse().find((span) => span.text.length > 0);
  if (!source) return { text };
  const next: TextSpan = { text };
  if (source.bold) next.bold = true;
  if (source.italic) next.italic = true;
  if (source.underline) next.underline = true;
  if (source.strikethrough) next.strikethrough = true;
  if (source.code) next.code = true;
  if (source.color) next.color = source.color;
  return next;
}

export function findInlineMarkdownShortcut(textBeforeCaret: string) {
  for (const shortcut of INLINE_MARKDOWN_SHORTCUTS) {
    if (!textBeforeCaret.endsWith(shortcut.close)) continue;
    const innerEnd = textBeforeCaret.length - shortcut.close.length;
    if (isEscaped(textBeforeCaret, innerEnd)) continue;
    const start = textBeforeCaret.lastIndexOf(shortcut.open, innerEnd - 1);
    if (start < 0) continue;
    if (isEscaped(textBeforeCaret, start)) continue;
    if (
      shortcut.open === "~" &&
      (textBeforeCaret[start - 1] === "~" || textBeforeCaret[start + 1] === "~")
    ) continue;
    const beforeOpen = textBeforeCaret[start - 1] ?? "";
    if (beforeOpen && /[\p{L}\p{N}_]/u.test(beforeOpen)) continue;
    const innerStart = start + shortcut.open.length;
    if (innerStart >= innerEnd) continue;
    const inner = textBeforeCaret.slice(innerStart, innerEnd);
    if (!inner.trim() || /^\s|\s$/.test(inner)) continue;
    return {
      ...shortcut,
      start,
      innerLength: inner.length,
    };
  }
  return null;
}

export function clearNativeInlineTypingState(mark: InlineMarkdownMark) {
  const command =
    mark === "bold"
      ? "bold"
      : mark === "italic"
        ? "italic"
        : mark === "strikethrough"
          ? "strikeThrough"
          : null;
  if (!command || typeof document === "undefined") return;
  try {
    if (document.queryCommandState(command)) document.execCommand(command, false);
  } catch {
    // Some browsers restrict queryCommandState/execCommand in synthetic tests.
  }
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function hasOpenInlineCodeDelimiter(text: string, beforeIndex: number) {
  let open = false;
  for (let i = 0; i < beforeIndex; i++) {
    if (text[i] !== "`" || isEscaped(text, i)) continue;
    open = !open;
  }
  return open;
}

function findUnescapedReverse(text: string, needle: string, from: number) {
  for (
    let index = Math.min(from, text.length - 1);
    index >= 0;
    index = text.lastIndexOf(needle, index - 1)
  ) {
    if (text[index] === needle && !isEscaped(text, index)) return index;
  }
  return -1;
}

export function unescapeMarkdownLinkLabelSpans(spans: TextSpan[]) {
  const unescape = (text: string) => {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\\" && /[\\`*_~\[\]]/.test(text[i + 1] ?? "")) {
        out += text[i + 1];
        i++;
      } else {
        out += text[i];
      }
    }
    return out;
  };
  return spans.map((span) => ({
    ...span,
    text: unescape(span.text),
  }));
}

export function findInlineMarkdownLinkShortcut(textBeforeCaret: string) {
  if (!textBeforeCaret.endsWith(")")) return null;
  const closeLabel = findUnescapedReverse(textBeforeCaret, "]", textBeforeCaret.length - 2);
  if (closeLabel < 0 || textBeforeCaret[closeLabel + 1] !== "(") return null;
  const linkMarker = closeLabel;
  const start = findUnescapedReverse(textBeforeCaret, "[", linkMarker - 1);
  if (start < 0) return null;
  const beforeOpen = textBeforeCaret[start - 1] ?? "";
  if (beforeOpen && /[\p{L}\p{N}_]/u.test(beforeOpen)) return null;

  const label = textBeforeCaret.slice(start + 1, linkMarker);
  const rawUrl = textBeforeCaret.slice(linkMarker + 2, -1);
  if (!label.trim() || /^\s|\s$/.test(label)) return null;

  const url = normalizePastedLink(rawUrl);
  if (!url) return null;
  return {
    start,
    labelLength: label.length,
    rawUrlLength: rawUrl.length,
    url,
  };
}

export function findTypedAutoLinkShortcut(textBeforeCaret: string) {
  const match = textBeforeCaret.match(/(\S+)(\s+)$/u);
  if (!match) return null;
  const token = match[1] ?? "";
  const whitespace = match[2] ?? "";
  if (!token || !whitespace) return null;

  const urlText = token.replace(/[.,;:!?]+$/u, "");
  if (!urlText) return null;
  const url = normalizePastedLink(urlText);
  if (!url) return null;
  return {
    start: textBeforeCaret.length - token.length - whitespace.length,
    urlLength: urlText.length,
    trailingLength: token.length - urlText.length + whitespace.length,
    url,
  };
}

export function typedMarkdownBlockFromText(text: string): PastedBlock | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed !== text || trimmed.includes("\n")) return null;
  if (trimmed === "```") {
    return {
      type: "code",
      content: { rich: [] },
      plainText: "",
    };
  }
  const parsed = parsePastedMarkdown(trimmed);
  if (parsed.length !== 1) return null;
  const [block] = parsed;
  if (!block || !TYPED_MARKDOWN_BLOCK_TYPES.has(block.type)) return null;
  if (block.children?.length) return null;
  if (block.type === "equation" && !block.content?.expression?.trim()) return null;
  return block;
}

export function isStructuredHtmlPaste(blocks: PastedBlock[]) {
  return (
    blocks.length > 1 ||
    blocks.some(
      (item) =>
        item.type !== "paragraph" ||
        (item.children?.length ?? 0) > 0 ||
        item.content?.rich?.some((span) => span.mention === "page")
    )
  );
}

export function isSingleRichParagraphHtmlPaste(blocks: PastedBlock[]) {
  if (blocks.length !== 1) return false;
  const [block] = blocks;
  if (!block || block.type !== "paragraph" || (block.children?.length ?? 0) > 0) return false;
  return (block.content?.rich ?? []).some(
    (span) =>
      !!(
        span.bold ||
        span.italic ||
        span.underline ||
        span.strikethrough ||
        span.code ||
        span.color ||
        span.link ||
        span.commentId ||
        span.mention ||
        span.pageId ||
        span.date ||
        span.userId ||
        span.iconUrl
      )
  );
}

export function normalizePastedLink(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || /\s/.test(trimmed)) return "";
  let candidate = trimmed;
  const bareDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
  const localhost = /^localhost(?::\d+)?(?:[/?#].*)?$/i;
  if (bareDomain.test(candidate) || localhost.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(candidate)) {
    return "";
  }
  return safeUrl(candidate);
}

export function isExternalPastedWebUrl(url: string) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Text carried by a pasted block, as spans — null when it has none. */
export function pastedBlockTextSpans(pasted: PastedBlock): TextSpan[] | null {
  const rich = pasted.content?.rich;
  if (Array.isArray(rich) && spansToPlainText(rich).length > 0) return rich;
  const text = pasted.plainText ?? "";
  if (text) return [{ text }];
  return null;
}

export function pastedUrlFallbackTitle(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./i, "") || url;
  } catch {
    return url;
  }
}

export type PastedUrlConversion =
  | "external_mention"
  | "page_mention"
  | "page_link"
  | "bookmark"
  | "embed"
  | "image"
  | "video"
  | "audio"
  | "file";
