import type { TextSpan } from "@/lib/types";
import { dateMentionDisplayText } from "./dateMentions";

// Rich text <-> HTML for contentEditable blocks. Pure functions (except
// htmlToSpans, which walks a live DOM node) so they can be unit-tested.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only allow safe link schemes (blocks javascript:/data:/vbscript: XSS). */
export function safeUrl(url: string | undefined): string {
  if (!url) return "";
  return /^(https?:|mailto:|\/|#)/i.test(url.trim()) ? url.trim() : "";
}

const COLOR_TOKENS = new Set([
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

const STYLE_TEXT_COLOR_BY_RGB = new Map([
  ["120,119,116", "gray"],
  ["159,107,83", "brown"],
  ["217,115,13", "orange"],
  ["203,145,47", "yellow"],
  ["68,131,97", "green"],
  ["51,126,169", "blue"],
  ["144,101,176", "purple"],
  ["193,76,138", "pink"],
  ["212,76,71", "red"],
  ["155,155,155", "gray"],
  ["186,133,111", "brown"],
  ["199,125,72", "orange"],
  ["202,152,73", "yellow"],
  ["82,158,114", "green"],
  ["94,135,201", "blue"],
  ["157,104,211", "purple"],
  ["209,87,150", "pink"],
  ["223,84,82", "red"],
]);

const STYLE_BACKGROUND_COLOR_BY_RGB = new Map([
  ["241,241,239", "gray_background"],
  ["244,238,238", "brown_background"],
  ["251,236,221", "orange_background"],
  ["251,243,219", "yellow_background"],
  ["237,243,236", "green_background"],
  ["231,243,248", "blue_background"],
  ["244,240,247", "purple_background"],
  ["249,238,243", "pink_background"],
  ["253,235,236", "red_background"],
  ["47,47,47", "gray_background"],
  ["74,50,40", "brown_background"],
  ["92,59,35", "orange_background"],
  ["86,67,40", "yellow_background"],
  ["36,61,48", "green_background"],
  ["20,58,78", "blue_background"],
  ["60,45,73", "purple_background"],
  ["78,44,60", "pink_background"],
  ["82,46,42", "red_background"],
]);

function spanToHtml(s: TextSpan): string {
  const dateMentionValue = s.mention === "date" ? safeDateMentionValue(s.date) : undefined;
  const text = dateMentionValue ? dateMentionDisplayText(dateMentionValue, s.text ?? "") : (s.text ?? "");
  let h = escapeHtml(text);
  if (s.code) h = `<code>${h}</code>`;
  if (s.bold) h = `<strong>${h}</strong>`;
  if (s.italic) h = `<em>${h}</em>`;
  if (s.underline) h = `<u>${h}</u>`;
  if (s.strikethrough) h = `<s>${h}</s>`;
  const color = safeColorToken(s.color);
  if (color) {
    h = `<span data-color="${escapeHtml(color)}">${h}</span>`;
  }
  const commentId = safeCommentId(s.commentId);
  if (commentId) {
    h = `<span data-comment-id="${escapeHtml(commentId)}">${h}</span>`;
  }
  const pageMentionId = s.mention === "page" ? safeMentionId(s.pageId) : undefined;
  if (pageMentionId) {
    const pageId = escapeHtml(pageMentionId);
    const hrefPageId = escapeHtml(encodeURIComponent(pageMentionId));
    return `<a href="/p/${hrefPageId}" data-mention="page" data-page-id="${pageId}" contenteditable="false">${h}</a>`;
  }
  if (dateMentionValue) {
    return `<span data-mention="date" data-date="${escapeHtml(dateMentionValue)}" contenteditable="false">${h}</span>`;
  }
  const personMentionId = s.mention === "person" ? safeMentionId(s.userId) : undefined;
  if (personMentionId) {
    return `<span data-mention="person" data-user-id="${escapeHtml(personMentionId)}" contenteditable="false">${h}</span>`;
  }
  const externalMentionHref = s.mention === "external" ? safeExternalMentionUrl(s.link) : "";
  if (externalMentionHref) {
    const iconUrl = safeExternalMentionUrl(s.iconUrl);
    const icon = iconUrl
      ? `<img src="${escapeHtml(iconUrl)}" alt="" draggable="false" data-mention-icon="external" />`
      : "";
    return `<a href="${escapeHtml(externalMentionHref)}" data-mention="external"${iconUrl ? ` data-icon-url="${escapeHtml(iconUrl)}"` : ""} contenteditable="false">${icon}<span data-mention-label="external">${h}</span></a>`;
  }
  const href = safeUrl(s.link);
  if (href) h = `<a href="${escapeHtml(href)}">${h}</a>`;
  return h;
}

export function spansToHtml(spans?: TextSpan[]): string {
  if (!spans || spans.length === 0) return "";
  return spans.map(spanToHtml).join("");
}

export function spansPlainText(spans?: TextSpan[]): string {
  return (spans ?? []).map((s) => s.text).join("");
}

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

function sameMarks(a: TextSpan, b: TextSpan): boolean {
  return MARK_KEYS.every((k) => a[k] === b[k]);
}

export function safeColorToken(color: string | undefined): string | undefined {
  return color && COLOR_TOKENS.has(color) ? color : undefined;
}

export function safeCommentId(commentId: string | undefined): string | undefined {
  if (!commentId || !/^[A-Za-z0-9_-]+$/.test(commentId)) return undefined;
  return commentId;
}

export function safeMentionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 200 || !/^[A-Za-z0-9._:@-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

export function safeDateMentionValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 80) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(
      trimmed
    );
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText, , zoneHourText, zoneMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  if (hourText === undefined) return trimmed;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const millis = millisText === undefined ? 0 : Number(millisText);
  if (hour > 23 || minute > 59 || second > 59 || millis > 999) return undefined;
  if (zoneHourText !== undefined) {
    const zoneHour = Number(zoneHourText);
    const zoneMinute = Number(zoneMinuteText);
    if (zoneHour > 23 || zoneMinute > 59) return undefined;
  }
  return trimmed;
}

export function safeExternalMentionUrl(url: string | undefined): string {
  const href = safeUrl(url);
  if (!href) return "";
  return /^https?:/i.test(href) ? href : "";
}

function rgbKeyFromCssColor(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed || trimmed === "transparent") return undefined;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const raw = hex[1];
    const full = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if ([r, g, b].every((part) => Number.isFinite(part))) return `${r},${g},${b}`;
  }

  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*([0-9.]+)\s*)?\)$/.exec(
      trimmed
    ) ??
    /^rgba?\(\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})(?:\s*\/\s*([0-9.]+))?\s*\)$/.exec(trimmed);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.slice(1, 4).map((part) => Number(part));
  const alpha = rgb[4] === undefined ? 1 : Number(rgb[4]);
  if ([r, g, b, alpha].some((part) => !Number.isFinite(part)) || alpha <= 0) return undefined;
  if ([r, g, b].some((part) => part < 0 || part > 255)) return undefined;
  return `${r},${g},${b}`;
}

function styleColorToken(el: HTMLElement): string | undefined {
  const backgroundKey = rgbKeyFromCssColor(el.style.backgroundColor);
  const background = backgroundKey ? STYLE_BACKGROUND_COLOR_BY_RGB.get(backgroundKey) : undefined;
  if (background) return background;
  const colorKey = rgbKeyFromCssColor(el.style.color);
  return colorKey ? STYLE_TEXT_COLOR_BY_RGB.get(colorKey) : undefined;
}

/** Merge adjacent spans that carry identical marks. */
export function coalesce(spans: TextSpan[]): TextSpan[] {
  const out: TextSpan[] = [];
  for (const s of spans) {
    if (s.text === "") continue;
    const last = out[out.length - 1];
    if (last && sameMarks(last, s)) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/** Walk a contentEditable element's DOM into a span list. (browser only) */
export function htmlToSpans(root: Node): TextSpan[] {
  const out: TextSpan[] = [];
  walk(root, {});
  return coalesce(out);

  function walk(node: Node, marks: Partial<TextSpan>) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = (child.textContent ?? "").replace(/\u200B/g, "");
        if (text) out.push({ ...marks, text });
        return;
      }
      if (child.nodeType !== 1) return;
      const el = child as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (tag === "br") {
        out.push({ ...marks, text: "\n" });
        return;
      }
      // Block-level elements (e.g. pasted <div>/<p>) imply a line break.
      const BLOCK = new Set([
        "div", "p", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6",
      ]);
      if (BLOCK.has(tag) && out.length > 0) out.push({ text: "\n" });
      const m: Partial<TextSpan> = { ...marks };
      if (
        el.dataset?.mention === "page" ||
        el.dataset?.mention === "date" ||
        el.dataset?.mention === "person" ||
        el.dataset?.mention === "external"
      ) {
        const text = el.textContent ?? "";
        if (el.dataset.mention === "page") {
          const pageId = safeMentionId(el.dataset.pageId);
          if (pageId) {
            out.push({ ...m, text, mention: "page", pageId });
            return;
          }
        } else if (el.dataset.mention === "date") {
          const date = safeDateMentionValue(el.dataset.date);
          if (date) {
            out.push({ ...m, text, mention: "date", date });
            return;
          }
        } else if (el.dataset.mention === "person") {
          const userId = safeMentionId(el.dataset.userId);
          if (userId) {
            out.push({ ...m, text, mention: "person", userId });
            return;
          }
        } else if (el.dataset.mention === "external") {
          const href = safeExternalMentionUrl(el.getAttribute("href") ?? undefined);
          if (href) {
            const iconUrl = safeExternalMentionUrl(el.dataset.iconUrl);
            out.push({
              ...m,
              text,
              mention: "external",
              link: href,
              ...(iconUrl ? { iconUrl } : {}),
            });
            return;
          }
        }
      }
      if (tag === "strong" || tag === "b") m.bold = true;
      else if (tag === "em" || tag === "i") m.italic = true;
      else if (tag === "u") m.underline = true;
      else if (tag === "s" || tag === "strike" || tag === "del") m.strikethrough = true;
      else if (tag === "code") m.code = true;
      else if (tag === "a") {
        const href = safeUrl(el.getAttribute("href") ?? undefined);
        if (href) m.link = href;
      }
      const dataColor = safeColorToken(el.dataset?.color);
      const inlineStyleColor = styleColorToken(el);
      if (dataColor || inlineStyleColor) m.color = dataColor ?? inlineStyleColor;
      if (el.dataset && el.dataset.commentId) m.commentId = safeCommentId(el.dataset.commentId);
      walk(el, m);
    });
  }
}

/** Split a span list at a plain-text character offset. */
export function splitSpans(
  spans: TextSpan[],
  offset: number
): [TextSpan[], TextSpan[]] {
  const before: TextSpan[] = [];
  const after: TextSpan[] = [];
  let acc = 0;
  for (const s of spans) {
    const len = s.text.length;
    if (acc >= offset) after.push(s);
    else if (acc + len <= offset) before.push(s);
    else {
      const cut = offset - acc;
      before.push({ ...s, text: s.text.slice(0, cut) });
      after.push({ ...s, text: s.text.slice(cut) });
    }
    acc += len;
  }
  return [coalesce(before), coalesce(after)];
}

export function concatSpans(a: TextSpan[], b: TextSpan[]): TextSpan[] {
  return coalesce([...a, ...b]);
}
