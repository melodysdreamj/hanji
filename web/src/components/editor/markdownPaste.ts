import type { BlockContent, BlockType, TextSpan } from "@/lib/types";
import { HANJI_BLOCKS_MIME, readTextWithMime } from "@/lib/clipboard";
import {
  normalizeLegacyHanjiClipboardHtml,
  normalizeLegacyHanjiUri,
} from "@/lib/legacyNamespace";
import { pageIdFromPageHref } from "@/lib/pageLinks";
import {
  activePastedBlockLabels,
  activePersistentGeneratedLabels,
} from "@/lib/persistentGeneratedLabels";
import { BLOCK_DEFS } from "./blocks";
import { coalesce, htmlToSpans, safeUrl } from "./richtext";

export interface PastedBlock {
  type: BlockType;
  content?: BlockContent;
  plainText?: string;
  children?: PastedBlock[];
}

interface PastedEntry {
  depth: number;
  block: PastedBlock;
}

const KNOWN_BLOCK_TYPES = new Set<BlockType>(BLOCK_DEFS.map((def) => def.type));
const INLINE_AUTO_LINK_RE =
  /^(https?:\/\/[^\s<>()]+|mailto:[^\s<>()]+|localhost(?::\d+)?(?:[/?#][^\s<>()]*)?|(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s<>()]*)?)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeInternalBlock(value: unknown): PastedBlock | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== "string" || !KNOWN_BLOCK_TYPES.has(value.type as BlockType)) return null;
  const children = Array.isArray(value.children)
    ? value.children
        .map(normalizeInternalBlock)
        .filter((child): child is PastedBlock => !!child)
    : undefined;
  return {
    type: value.type as BlockType,
    ...(isRecord(value.content) ? { content: value.content as BlockContent } : {}),
    ...(typeof value.plainText === "string" ? { plainText: value.plainText } : {}),
    ...(children && children.length > 0 ? { children } : {}),
  };
}

function normalizeInlineAutoLink(raw: string) {
  if (!raw || /\s/.test(raw)) return "";
  let candidate = raw;
  const bareDomain = /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i;
  const localhost = /^localhost(?::\d+)?(?:[/?#].*)?$/i;
  if (bareDomain.test(candidate) || localhost.test(candidate)) {
    candidate = `https://${candidate}`;
  } else if (!/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(candidate)) {
    return "";
  }
  return safeUrl(candidate);
}

function findInlineAutoLink(text: string, offset: number) {
  const previous = text[offset - 1] ?? "";
  if (previous && /[\p{L}\p{N}_@.-]/u.test(previous)) return null;

  const match = text.slice(offset).match(INLINE_AUTO_LINK_RE);
  if (!match) return null;

  const raw = match[1] ?? "";
  const linkText = raw.replace(/[.,;:!?]+$/u, "");
  if (!linkText) return null;

  const url = normalizeInlineAutoLink(linkText);
  if (!url) return null;

  return {
    text: linkText,
    trailing: raw.slice(linkText.length),
    rawLength: raw.length,
    url,
  };
}

function isEscaped(text: string, index: number) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) slashCount++;
  return slashCount % 2 === 1;
}

function findUnescaped(text: string, needle: string, from: number) {
  for (let index = text.indexOf(needle, from); index >= 0; index = text.indexOf(needle, index + 1)) {
    if (!isEscaped(text, index)) return index;
  }
  return -1;
}

function escapedMarkdownLiteral(text: string, offset: number) {
  if (text[offset] !== "\\") return null;
  const next = text[offset + 1] ?? "";
  return /[\\`*_~[\]|]/.test(next) ? next : null;
}

function unescapeMarkdownLiteral(text: string) {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const escapedLiteral = escapedMarkdownLiteral(text, index);
    if (escapedLiteral) {
      out += escapedLiteral;
      index++;
    } else {
      out += text[index];
    }
  }
  return out;
}

function findInlineCodeSpan(text: string, offset: number) {
  if (text[offset] !== "`" || isEscaped(text, offset)) return null;
  const fence = text.slice(offset).match(/^`+/)?.[0] ?? "";
  if (!fence) return null;
  const close = findUnescaped(text, fence, offset + fence.length);
  if (close < 0) return null;

  let inner = text.slice(offset + fence.length, close);
  if (!inner) return null;
  if (
    fence.length > 1 &&
    inner.length >= 2 &&
    inner.startsWith(" ") &&
    inner.endsWith(" ") &&
    (inner[1] === "`" || inner[inner.length - 2] === "`")
  ) {
    inner = inner.slice(1, -1);
  }
  return {
    text: inner,
    nextOffset: close + fence.length,
  };
}

export function parseInternalPastedBlocks(data: DataTransfer): PastedBlock[] {
  const raw = readTextWithMime(data, HANJI_BLOCKS_MIME);
  if (!raw) return [];
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!isRecord(payload) || payload.version !== 1 || !Array.isArray(payload.blocks)) return [];
    return payload.blocks
      .map(normalizeInternalBlock)
      .filter((block): block is PastedBlock => !!block);
  } catch {
    return [];
  }
}

/**
 * Tokenize a single line of markdown into styled spans, handling inline
 * bold, italic, code, strikethrough and [label](url) links.
 * Code spans suppress nested formatting. Unmatched markers are left literal.
 */
export function parseInlineMarkdown(text: string): TextSpan[] {
  if (!text) return [];
  const out: TextSpan[] = [];
  let i = 0;
  let plain = "";
  const flush = (marks: Partial<TextSpan>, value: string) => {
    if (value) out.push({ ...marks, text: value });
  };
  const flushPlain = () => {
    if (plain) {
      out.push({ text: plain });
      plain = "";
    }
  };

  const tryDelim = (open: string, mark: keyof TextSpan): boolean => {
    if (isEscaped(text, i) || !text.startsWith(open, i)) return false;
    const close = findUnescaped(text, open, i + open.length);
    if (close < 0) return false;
    const inner = text.slice(i + open.length, close);
    if (!inner || /^\s|\s$/.test(inner)) return false;
    flushPlain();
    if (mark === "code") {
      // Code suppresses nested marks.
      flush({ code: true }, inner);
    } else {
      for (const span of parseInlineMarkdown(inner)) {
        out.push({ ...span, [mark]: true });
      }
    }
    i = close + open.length;
    return true;
  };

  while (i < text.length) {
    const ch = text[i];
    const escapedLiteral = escapedMarkdownLiteral(text, i);
    if (escapedLiteral) {
      plain += escapedLiteral;
      i += 2;
      continue;
    }
    const codeSpan = findInlineCodeSpan(text, i);
    if (codeSpan) {
      flushPlain();
      flush({ code: true }, codeSpan.text);
      i = codeSpan.nextOffset;
      continue;
    }
    // Links: [label](url)
    if (ch === "[" && !isEscaped(text, i)) {
      const labelEnd = findUnescaped(text, "]", i + 1);
      if (labelEnd > 0 && text[labelEnd + 1] === "(") {
        const urlEnd = findUnescaped(text, ")", labelEnd + 2);
        if (urlEnd > labelEnd) {
          const label = text.slice(i + 1, labelEnd);
          const url = text.slice(labelEnd + 2, urlEnd).trim();
          const date = dateFromMentionHref(url);
          if (label && date && !/\s/.test(url)) {
            flushPlain();
            for (const span of parseInlineMarkdown(label)) {
              out.push({ ...span, mention: "date", date });
            }
            i = urlEnd + 1;
            continue;
          }
          const userId = personIdFromMentionHref(url);
          if (label && userId && !/\s/.test(url)) {
            flushPlain();
            for (const span of parseInlineMarkdown(label)) {
              out.push({ ...span, mention: "person", userId });
            }
            i = urlEnd + 1;
            continue;
          }
          const pageId = pageIdFromPageHref(url);
          if (label && pageId && !/\s/.test(url)) {
            flushPlain();
            for (const span of parseInlineMarkdown(label)) {
              out.push({ ...span, mention: "page", pageId });
            }
            i = urlEnd + 1;
            continue;
          }
          const href = normalizeInlineAutoLink(url);
          if (label && href && !/\s/.test(url)) {
            flushPlain();
            for (const span of parseInlineMarkdown(label)) {
              out.push({ ...span, link: href });
            }
            i = urlEnd + 1;
            continue;
          }
        }
      }
    }
    const autoLink = findInlineAutoLink(text, i);
    if (autoLink) {
      flushPlain();
      out.push({ text: autoLink.text, link: autoLink.url });
      if (autoLink.trailing) out.push({ text: autoLink.trailing });
      i += autoLink.rawLength;
      continue;
    }
    if ((ch === "*" || ch === "_") && tryDelim(ch + ch, "bold")) continue;
    if (ch === "~" && tryDelim("~~", "strikethrough")) continue;
    if ((ch === "*" || ch === "_") && tryDelim(ch, "italic")) continue;
    plain += ch;
    i++;
  }
  flushPlain();
  return out;
}

function parseWikiPageLink(text: string) {
  if (!text.startsWith("[[")) return null;
  const labelEnd = findUnescaped(text, "]]", 2);
  if (labelEnd < 0) return null;
  const label =
    unescapeMarkdownLiteral(text.slice(2, labelEnd)).trim() ||
    activePastedBlockLabels().linkToPage;
  const suffix = text.slice(labelEnd + 2);
  if (!suffix) return { label, href: "" };
  if (!suffix.startsWith("(") || !suffix.endsWith(")")) return null;
  return { label, href: suffix.slice(1, -1).trim() };
}

function parseMarkdownLinkLine(text: string, image = false) {
  const prefix = image ? "![" : "[";
  if (!text.startsWith(prefix)) return null;
  const labelStart = prefix.length;
  const labelEnd = findUnescaped(text, "]", labelStart);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return null;
  const hrefEnd = findUnescaped(text, ")", labelEnd + 2);
  if (hrefEnd !== text.length - 1) return null;
  return {
    label: unescapeMarkdownLiteral(text.slice(labelStart, labelEnd)),
    href: text.slice(labelEnd + 2, hrefEnd).trim(),
  };
}

function parseBracketCommand(text: string, command: string) {
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const labelEnd = findUnescaped(text, "]", 1);
  if (labelEnd !== text.length - 1) return null;
  const label = unescapeMarkdownLiteral(text.slice(1, labelEnd));
  const match = label.match(new RegExp(`^${command}(?::\\s*(.*))?$`, "i"));
  if (!match) return null;
  return match[1]?.trim() ?? "";
}

function parseTabLabelCommand(text: string) {
  const value = parseBracketCommand(text, "tab");
  if (value === null) return null;
  const match = value.match(/^(\S+)\s+(.+)$/u);
  const untitled = activePersistentGeneratedLabels().untitled;
  if (!match) return { icon: "", label: value || untitled };
  return {
    icon: match[1],
    label: match[2].trim() || untitled,
  };
}

const rich = (text: string): TextSpan[] => parseInlineMarkdown(text);
const plain = (content?: BlockContent) => (content?.rich ?? []).map((span) => span.text).join("");
const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "ul",
]);

function isTableRow(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.slice(1, -1).includes("|");
}

function splitTableRow(line: string) {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index++) {
    const ch = body[index];
    if (ch === "|" && !isEscaped(body, index)) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells.map((cell) => unescapeMarkdownLiteral(cell.trim()).replace(/<br\s*\/?>/gi, "\n"));
}

function isTableSeparator(line: string) {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function normalizeTable(table: string[][]) {
  const colCount = Math.max(2, ...table.map((row) => row.length));
  return table.map((row) => Array.from({ length: colCount }, (_, index) => row[index] ?? ""));
}

export function parseMarkdownTableRows(text: string): string[][] | null {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2 || !isTableRow(lines[0]) || !isTableSeparator(lines[1])) return null;

  const table = [splitTableRow(lines[0])];
  for (let index = 2; index < lines.length; index++) {
    if (!isTableRow(lines[index])) break;
    table.push(splitTableRow(lines[index]));
  }
  return normalizeTable(table);
}

function isBlockElement(node: Element) {
  return BLOCK_TAGS.has(node.tagName.toLowerCase());
}

function elementHasBlockChildren(el: Element) {
  return Array.from(el.children).some(isBlockElement);
}

function trimRich(spans: TextSpan[]) {
  const next = spans.map((span) => ({ ...span }));
  while (next.length > 0) {
    const text = next[0].text.replace(/^\s+/, "");
    if (text) {
      next[0] = { ...next[0], text };
      break;
    }
    next.shift();
  }
  while (next.length > 0) {
    const last = next[next.length - 1];
    const text = last.text.replace(/\s+$/, "");
    if (text) {
      next[next.length - 1] = { ...last, text };
      break;
    }
    next.pop();
  }
  return coalesce(next);
}

function richFromHtmlNode(node: Node, removeSelector?: string) {
  const clone = node.cloneNode(true);
  if (clone instanceof Element && removeSelector) {
    clone.querySelectorAll(removeSelector).forEach((item) => item.remove());
  }
  return trimRich(
    htmlToSpans(clone).map((span) => {
      const pageId = pageIdFromPageHref(span.link);
      if (!pageId) return span;
      const next = { ...span };
      delete next.link;
      return { ...next, mention: "page" as const, pageId };
    })
  );
}

function blockFromRich(type: BlockType, richText: TextSpan[], content: BlockContent = {}) {
  const nextContent = { ...content, rich: richText };
  return {
    type,
    content: nextContent,
    plainText: plain(nextContent),
  } satisfies PastedBlock;
}

function tableFromHtml(table: HTMLTableElement) {
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((row) =>
      Array.from(row.querySelectorAll("th,td")).map((cell) =>
        (cell.textContent ?? "").replace(/\s+/g, " ").trim()
      )
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? normalizeTable(rows) : null;
}

function normalizeHtmlCodeLanguage(value?: string) {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  const aliases: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    shell: "bash",
    sh: "bash",
    html5: "html",
  };
  return aliases[raw] ?? raw;
}

function fileNameFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "") || parsed.hostname;
  } catch {
    return url.split("/").filter(Boolean).at(-1) || activePastedBlockLabels().file;
  }
}

function safeAssetUrl(raw: string) {
  const url = safeUrl(raw.trim());
  if (!url || url.startsWith("#") || /^mailto:/i.test(url)) return "";
  return url;
}

function dateFromMentionHref(raw: string) {
  const value = normalizeLegacyHanjiUri(raw.trim());
  if (!/^hanji:\/\/date\//i.test(value)) return "";
  const date = value.replace(/^hanji:\/\/date\//i, "").split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(date);
  } catch {
    return date;
  }
}

function personIdFromMentionHref(raw: string) {
  const value = normalizeLegacyHanjiUri(raw.trim());
  if (!/^hanji:\/\/person\//i.test(value)) return "";
  const userId = value.replace(/^hanji:\/\/person\//i, "").split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(userId);
  } catch {
    return userId;
  }
}

function block(type: BlockType, text: string, content?: BlockContent): PastedBlock {
  const nextContent = content ?? { rich: rich(text) };
  return { type, content: nextContent, plainText: plain(nextContent) || text };
}

function parseHtmlChildren(parent: ParentNode): PastedBlock[] {
  return Array.from(parent.childNodes).flatMap(parseHtmlNode);
}

function parseHanjiTabLabel(node: HTMLElement): PastedBlock | null {
  const untitled = activePersistentGeneratedLabels().untitled;
  const titleNode = node.querySelector<HTMLElement>(":scope > [data-hanji-tab-title]");
  const panelNode = node.querySelector<HTMLElement>(":scope > [data-hanji-tab-panel]");
  const richText = titleNode
    ? richFromHtmlNode(titleNode, "[data-hanji-tab-icon-text]")
    : richFromHtmlNode(node, "[data-hanji-tab-panel],[data-hanji-tab-icon-text]");
  const normalizedRich = richText.length > 0 ? richText : rich(untitled);
  const icon = (node.getAttribute("data-hanji-tab-icon") ?? "").trim();
  const content: BlockContent = {
    rich: normalizedRich,
    ...(icon ? { icon } : {}),
  };
  const children = panelNode ? parseHtmlChildren(panelNode) : [];
  return {
    type: "paragraph",
    content,
    plainText: plain(content) || untitled,
    ...(children.length > 0 ? { children } : {}),
  };
}

function parseHanjiTab(node: HTMLElement): PastedBlock | null {
  if (node.getAttribute("data-hanji-block-type") !== "tab") return null;
  const children = Array.from(node.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .filter((child) => child.matches("[data-hanji-tab-label]"))
    .map(parseHanjiTabLabel)
    .filter((child): child is PastedBlock => !!child);
  return {
    type: "tab",
    content: { rich: [] },
    plainText: activePastedBlockLabels().tabs,
    ...(children.length > 0 ? { children } : {}),
  };
}

function parseList(list: HTMLOListElement | HTMLUListElement): PastedBlock[] {
  const ordered = list.tagName.toLowerCase() === "ol";
  return Array.from(list.children)
    .filter((child): child is HTMLLIElement => child.tagName.toLowerCase() === "li")
    .map((item) => {
      const checkbox = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const nested = Array.from(item.children).filter(
        (child) =>
          child.tagName.toLowerCase() === "ul" ||
          child.tagName.toLowerCase() === "ol" ||
          child.tagName.toLowerCase() === "details"
      );
      const richText = richFromHtmlNode(
        item,
        'ul,ol,details,input[type="checkbox"]'
      );
      const pasted = blockFromRich(
        checkbox ? "to_do" : ordered ? "numbered_list_item" : "bulleted_list_item",
        richText,
        checkbox ? { checked: checkbox.checked } : {}
      );
      const children = nested.flatMap(parseHtmlNode);
      return children.length > 0 ? { ...pasted, children } : pasted;
    });
}

function parseDetails(details: HTMLDetailsElement): PastedBlock[] {
  const summary = Array.from(details.children).find(
    (child) => child.tagName.toLowerCase() === "summary"
  );
  const richText = summary
    ? richFromHtmlNode(summary)
    : richFromHtmlNode(details, "details,summary");
  const children = Array.from(details.childNodes)
    .filter((child) => child !== summary)
    .flatMap(parseHtmlNode);
  const pasted = blockFromRich("toggle", richText, { collapsed: !details.open });
  return [{ ...pasted, ...(children.length > 0 ? { children } : {}) }];
}

function parseHtmlNode(node: Node): PastedBlock[] {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
    return text ? [block("paragraph", text)] : [];
  }
  if (!(node instanceof HTMLElement)) return [];

  const tag = node.tagName.toLowerCase();
  if (node.matches("[data-hanji-copy]")) return parseHtmlChildren(node);
  const hanjiTab = parseHanjiTab(node);
  if (hanjiTab) return [hanjiTab];
  if (node.matches("[data-hanji-tab-label]")) {
    const hanjiTabLabel = parseHanjiTabLabel(node);
    return hanjiTabLabel ? [hanjiTabLabel] : [];
  }

  if (tag === "ul" || tag === "ol") return parseList(node as HTMLUListElement | HTMLOListElement);
  if (tag === "details") return parseDetails(node as HTMLDetailsElement);
  if (tag === "hr") return [block("divider", "", { rich: [] })];
  if (tag === "table") {
    const table = tableFromHtml(node as HTMLTableElement);
    return table
      ? [
          block("simple_table", table.flat().join("\n"), {
            table,
            headerRow: true,
            headerColumn: false,
          }),
        ]
      : [];
  }
  if (tag === "pre") {
    const code = node.textContent?.replace(/\n$/, "") ?? "";
    const language = normalizeHtmlCodeLanguage(
      node.querySelector("code")?.className.match(/language-([\w-]+)/)?.[1]
    );
    return [
      block("code", code, {
        rich: code ? [{ text: code }] : [],
        language,
      }),
    ];
  }
  if (tag === "figure") {
    const img = node.querySelector("img");
    const url = safeAssetUrl(img?.getAttribute("src") ?? "");
    if (url) {
      const captionNode = node.querySelector("figcaption");
      const caption = captionNode
        ? richFromHtmlNode(captionNode)
        : rich(img?.getAttribute("alt") ?? "");
      return [
        block("image", plain({ rich: caption }), {
          url,
          caption,
        }),
      ];
    }
    return parseHtmlChildren(node);
  }
  if (tag === "img") {
    const url = safeAssetUrl(node.getAttribute("src") ?? "");
    const caption = rich(node.getAttribute("alt") ?? "");
    return url
      ? [
          block("image", plain({ rich: caption }), {
            url,
            caption,
          }),
        ]
      : [];
  }

  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    const type: BlockType =
      tag === "h1"
        ? "heading_1"
        : tag === "h2"
          ? "heading_2"
          : tag === "h3"
            ? "heading_3"
            : "heading_4";
    return [blockFromRich(type, richFromHtmlNode(node))];
  }
  if (tag === "blockquote") {
    const richText = richFromHtmlNode(node, "blockquote,ul,ol,details,table,pre,figure");
    const pasted = blockFromRich("quote", richText);
    const children = Array.from(node.children)
      .filter((child) => {
        const childTag = child.tagName.toLowerCase();
        return childTag === "ul" || childTag === "ol" || childTag === "details";
      })
      .flatMap(parseHtmlNode);
    return [{ ...pasted, ...(children.length > 0 ? { children } : {}) }];
  }
  if (tag === "p") return [blockFromRich("paragraph", richFromHtmlNode(node))];
  if (tag === "div" || tag === "section" || tag === "article" || tag === "aside") {
    if (elementHasBlockChildren(node)) return parseHtmlChildren(node);
    const richText = richFromHtmlNode(node);
    return richText.length > 0 ? [blockFromRich("paragraph", richText)] : [];
  }

  if (elementHasBlockChildren(node)) return parseHtmlChildren(node);
  const richText = richFromHtmlNode(node);
  return richText.length > 0 ? [blockFromRich("paragraph", richText)] : [];
}

export function parsePastedHtml(html: string): PastedBlock[] {
  if (!html.trim() || typeof DOMParser === "undefined") return [];
  try {
    const doc = new DOMParser().parseFromString(
      normalizeLegacyHanjiClipboardHtml(html),
      "text/html"
    );
    const root = doc.body.querySelector("[data-hanji-copy]") ?? doc.body;
    return parseHtmlChildren(root).filter((item) => {
      if (item.type === "divider" || item.type === "simple_table" || item.type === "image") return true;
      return !!item.plainText || (item.children?.length ?? 0) > 0;
    });
  } catch {
    return [];
  }
}

function lineDepth(line: string) {
  const indent = line.match(/^[\t ]*/)?.[0] ?? "";
  const width = indent.replace(/\t/g, "  ").length;
  return Math.floor(width / 2);
}

function stripDepthIndent(line: string, depth: number) {
  let remaining = depth * 2;
  let index = 0;
  while (index < line.length && remaining > 0) {
    if (line[index] === "\t") remaining -= 2;
    else if (line[index] === " ") remaining -= 1;
    else break;
    index++;
  }
  return line.slice(index);
}

function codeFenceStart(line: string) {
  const match = line.match(/^(`{3,})(.*)$/);
  if (!match) return null;
  return {
    fenceLength: match[1].length,
    language: match[2].trim().replace(/[^\w-]/g, ""),
  };
}

function isCodeFenceEnd(line: string, fenceLength: number) {
  const match = line.trim().match(/^(`{3,})$/);
  return !!match && match[1].length >= fenceLength;
}

function nestEntries(entries: PastedEntry[]) {
  const roots: PastedBlock[] = [];
  const stack: PastedEntry[] = [];
  for (const entry of entries) {
    while (stack.length > 0 && entry.depth <= stack[stack.length - 1].depth) stack.pop();
    const parent = stack[stack.length - 1]?.block;
    if (parent) {
      parent.children = [...(parent.children ?? []), entry.block];
    } else {
      roots.push(entry.block);
    }
    stack.push(entry);
  }
  return roots;
}

export function parsePastedMarkdown(text: string): PastedBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const entries: PastedEntry[] = [];
  let i = 0;

  function push(depth: number, pasted: PastedBlock) {
    entries.push({ depth, block: pasted });
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";
    const depth = lineDepth(line);
    const contentLine = stripDepthIndent(line, depth);
    const trimmed = contentLine.trimEnd();
    const stripped = trimmed.trim();

    if (!stripped) {
      i++;
      continue;
    }

    const codeFence = codeFenceStart(stripped);
    if (codeFence) {
      const code: string[] = [];
      i++;
      while (
        i < lines.length &&
        !isCodeFenceEnd(stripDepthIndent(lines[i] ?? "", depth), codeFence.fenceLength)
      ) {
        code.push(stripDepthIndent(lines[i] ?? "", depth));
        i++;
      }
      if (i < lines.length) i++;
      const value = code.join("\n");
      push(depth, block("code", value, {
        rich: value ? [{ text: value }] : [],
        language: codeFence.language || undefined,
      }));
      continue;
    }

    if (stripped === "$$") {
      const equation: string[] = [];
      i++;
      while (i < lines.length && (lines[i] ?? "").trim() !== "$$") {
        equation.push(stripDepthIndent(lines[i] ?? "", depth));
        i++;
      }
      if (i < lines.length) i++;
      const expression = equation.join("\n").trim();
      push(depth, block("equation", expression, { expression }));
      continue;
    }

    if (isTableRow(trimmed) && isTableSeparator(lines[i + 1] ?? "")) {
      let consumed = 2;
      while (i + consumed < lines.length && isTableRow(lines[i + consumed] ?? "")) consumed++;
      const markdownTable = parseMarkdownTableRows(lines.slice(i, i + consumed).join("\n"));
      if (markdownTable) {
        i += consumed;
        push(
          depth,
          block("simple_table", markdownTable.flat().join("\n"), {
            table: markdownTable,
            headerRow: true,
            headerColumn: false,
          })
        );
        continue;
      }
    }

    const wikiPageLink = parseWikiPageLink(stripped);
    const markdownImage = parseMarkdownLinkLine(stripped, true);
    const markdownLink = parseMarkdownLinkLine(stripped);
    const buttonLabel = parseBracketCommand(stripped, "button");
    const tabLabel = parseTabLabelCommand(stripped);

    if (stripped === "---" || stripped === "***") {
      push(depth, block("divider", "", { rich: [] }));
    } else if (/^[▶▸]\s+####\s+/.test(stripped)) {
      push(depth, block("toggle_heading_4", stripped.replace(/^[▶▸]\s+####\s+/, "")));
    } else if (/^[▶▸]\s+###\s+/.test(stripped)) {
      push(depth, block("toggle_heading_3", stripped.replace(/^[▶▸]\s+###\s+/, "")));
    } else if (/^[▶▸]\s+##\s+/.test(stripped)) {
      push(depth, block("toggle_heading_2", stripped.replace(/^[▶▸]\s+##\s+/, "")));
    } else if (/^[▶▸]\s+#\s+/.test(stripped)) {
      push(depth, block("toggle_heading_1", stripped.replace(/^[▶▸]\s+#\s+/, "")));
    } else if (/^[▶▸]\s+/.test(stripped)) {
      push(depth, block("toggle", stripped.replace(/^[▶▸]\s+/, "")));
    } else if (/^#{1,4}\s+/.test(stripped)) {
      const level = stripped.match(/^#+/)?.[0].length ?? 1;
      const value = stripped.replace(/^#{1,4}\s+/, "");
      push(
        depth,
        block(
          level === 1
            ? "heading_1"
            : level === 2
              ? "heading_2"
              : level === 3
                ? "heading_3"
                : "heading_4",
          value
        )
      );
    } else if (/^[-*]\s+\[[ xX]\]\s+/.test(stripped)) {
      const checked = /^[-*]\s+\[[xX]\]/.test(stripped);
      const value = stripped.replace(/^[-*]\s+\[[ xX]\]\s+/, "");
      push(depth, block("to_do", value, { rich: rich(value), checked }));
    } else if (/^[-*]\s+/.test(stripped)) {
      push(depth, block("bulleted_list_item", stripped.replace(/^[-*]\s+/, "")));
    } else if (/^\d+\.\s+/.test(stripped)) {
      push(depth, block("numbered_list_item", stripped.replace(/^\d+\.\s+/, "")));
    } else if (markdownImage) {
      const caption = markdownImage.label;
      const url = safeAssetUrl(markdownImage.href);
      if (url) {
        push(
          depth,
          block("image", caption, {
            url,
            caption: rich(caption),
          })
        );
      } else {
        push(depth, block("paragraph", stripped));
      }
    } else if (markdownLink && /^video$/i.test(markdownLink.label.trim())) {
      const url = safeAssetUrl(markdownLink.href);
      push(depth, url ? block("video", url, { url }) : block("paragraph", stripped));
    } else if (markdownLink && /^audio$/i.test(markdownLink.label.trim())) {
      const url = safeAssetUrl(markdownLink.href);
      push(depth, url ? block("audio", url, { url }) : block("paragraph", stripped));
    } else if (markdownLink && /^embed$/i.test(markdownLink.label.trim())) {
      const url = safeAssetUrl(markdownLink.href);
      push(depth, url ? block("embed", url, { url }) : block("paragraph", stripped));
    } else if (markdownLink && /^file(?::|$)/i.test(markdownLink.label.trim())) {
      const url = safeAssetUrl(markdownLink.href);
      const fileName = markdownLink.label.replace(/^file(?::\s*)?/i, "").trim() || fileNameFromUrl(url);
      push(depth, url ? block("file", fileName, { url, fileName }) : block("paragraph", stripped));
    } else if (markdownLink && /^https?:\/\//i.test(markdownLink.href)) {
      const label = markdownLink.label.trim();
      const url = safeAssetUrl(markdownLink.href);
      if (label === url) push(depth, block("bookmark", url, { url }));
      else push(depth, block("paragraph", stripped));
    } else if (buttonLabel !== null) {
      const generatedBlockLabels = activePastedBlockLabels();
      const label = buttonLabel || generatedBlockLabels.newButton;
      push(
        depth,
        block("button", label, {
          rich: [],
          buttonLabel: label,
          buttonTemplate: [{
            type: "to_do",
            content: { rich: rich(generatedBlockLabels.newTask), checked: false },
          }],
        })
      );
    } else if (/^\[table of contents\]$/i.test(stripped)) {
      push(depth, block("table_of_contents", activePastedBlockLabels().tableOfContents, { rich: [] }));
    } else if (/^\[breadcrumb\]$/i.test(stripped)) {
      push(depth, block("breadcrumb", activePastedBlockLabels().breadcrumb, { rich: [] }));
    } else if (/^\[synced block\]$/i.test(stripped)) {
      push(depth, block("synced_block", activePastedBlockLabels().syncedBlock, { rich: [] }));
    } else if (/^\[tabs\]$/i.test(stripped)) {
      push(depth, block("tab", activePastedBlockLabels().tabs, { rich: [] }));
    } else if (tabLabel) {
      push(
        depth,
        block("paragraph", tabLabel.label, {
          rich: rich(tabLabel.label),
          ...(tabLabel.icon ? { icon: tabLabel.icon } : {}),
        })
      );
    } else if (wikiPageLink) {
      const childPageId = pageIdFromPageHref(wikiPageLink.href);
      push(
        depth,
        block("link_to_page", wikiPageLink.label, childPageId ? { rich: [], childPageId } : { rich: [] })
      );
    } else if (/^>\s+/.test(stripped)) {
      const value = stripped.replace(/^>\s+/, "");
      const callout = value.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})\s+(.+)$/u);
      if (callout) {
        push(depth, block("callout", callout[2], { rich: rich(callout[2]), icon: callout[1] }));
      } else {
        push(depth, block("quote", value));
      }
    } else if (/^\$\$(.+)\$\$$/.test(stripped)) {
      const expression = stripped.replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
      push(depth, block("equation", expression, { expression }));
    } else {
      push(depth, block("paragraph", trimmed));
    }
    i++;
  }

  return nestEntries(entries);
}
