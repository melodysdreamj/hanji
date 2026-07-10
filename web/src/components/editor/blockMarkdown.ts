import type { Block, TextSpan } from "@/lib/types";
import { spansToPlainText } from "@/lib/types";
import {
  escapeHtml,
  safeColorToken,
  safeDateMentionValue,
  safeExternalMentionUrl,
  safeMentionId,
  safeUrl,
} from "./richtext";
import { dateMentionDisplayText } from "./dateMentions";

const CLIPBOARD_COLORS: Record<string, string> = {
  gray: "rgb(120, 119, 116)",
  brown: "rgb(159, 107, 83)",
  orange: "rgb(217, 115, 13)",
  yellow: "rgb(203, 145, 47)",
  green: "rgb(68, 131, 97)",
  blue: "rgb(51, 126, 169)",
  purple: "rgb(144, 101, 176)",
  pink: "rgb(193, 76, 138)",
  red: "rgb(212, 76, 71)",
  gray_background: "rgb(241, 241, 239)",
  brown_background: "rgb(244, 238, 238)",
  orange_background: "rgb(251, 236, 221)",
  yellow_background: "rgb(251, 243, 219)",
  green_background: "rgb(237, 243, 236)",
  blue_background: "rgb(231, 243, 248)",
  purple_background: "rgb(244, 240, 247)",
  pink_background: "rgb(249, 238, 243)",
  red_background: "rgb(253, 235, 236)",
};

function markdownHref(href: string) {
  return href.replace(/\s/g, "%20").replace(/\)/g, "%29");
}

function markdownTextLiteral(text: string) {
  return text.replace(/\\/g, "\\\\").replace(/([`*_~\[\]])/g, "\\$1");
}

function markdownCodeFence(text: string) {
  const longest = Math.max(
    0,
    ...Array.from(text.matchAll(/`+/g), (match) => match[0].length)
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function markdownCodeBlock(text: string, language: unknown) {
  const fence = markdownCodeFence(text);
  const info = String(language ?? "").replace(/[^\w-]/g, "");
  return `${fence}${info}\n${text}\n${fence}`;
}

function markdownInlineCode(text: string) {
  const body = text.replace(/\n/g, " ");
  const longest = Math.max(
    0,
    ...Array.from(body.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = "`".repeat(
    Math.max(1, longest + 1)
  );
  const padded = body.startsWith("`") || body.endsWith("`") ? ` ${body} ` : body;
  return `${fence}${padded}${fence}`;
}

function dateMentionHref(date: string) {
  return `notionlike://date/${encodeURIComponent(date)}`;
}

function personMentionHref(userId: string) {
  return `notionlike://person/${encodeURIComponent(userId)}`;
}

function clipboardStyle(color?: string, block = false) {
  const token = safeColorToken(color);
  if (!token) return "";
  const value = CLIPBOARD_COLORS[token];
  if (!value) return "";
  const styles = token.endsWith("_background")
    ? [`background-color: ${value}`]
    : [`color: ${value}`];
  if (token.endsWith("_background")) {
    styles.push(block ? "padding: 3px 6px" : "border-radius: 3px", "box-decoration-break: clone");
  }
  return ` style="${escapeHtml(styles.join("; "))}"`;
}

function clipboardInlineHtml(spans?: TextSpan[]) {
  if (!spans || spans.length === 0) return "";
  return spans
    .map((span) => {
      const date = span.mention === "date" ? safeDateMentionValue(span.date) : undefined;
      const raw = date ? dateMentionDisplayText(date, span.text ?? "") : (span.text ?? "");
      if (!raw) return "";
      let html = escapeHtml(raw).replace(/\n/g, "<br>");
      if (span.code) html = `<code>${html}</code>`;
      if (span.bold) html = `<strong>${html}</strong>`;
      if (span.italic) html = `<em>${html}</em>`;
      if (span.underline) html = `<u>${html}</u>`;
      if (span.strikethrough) html = `<s>${html}</s>`;
      const color = safeColorToken(span.color);
      if (color) {
        html = `<span${clipboardStyle(color)}>${html}</span>`;
      }
      const pageId = span.mention === "page" ? safeMentionId(span.pageId) : undefined;
      if (pageId) {
        const href = `/p/${encodeURIComponent(pageId)}`;
        return `<a href="${escapeHtml(href)}" data-mention="page" data-page-id="${escapeHtml(pageId)}">${html}</a>`;
      }
      if (date) {
        return `<span data-mention="date" data-date="${escapeHtml(date)}">${html}</span>`;
      }
      const userId = span.mention === "person" ? safeMentionId(span.userId) : undefined;
      if (userId) {
        return `<span data-mention="person" data-user-id="${escapeHtml(userId)}">${html}</span>`;
      }
      const externalMentionHref = span.mention === "external" ? safeExternalMentionUrl(span.link) : "";
      if (externalMentionHref) {
        const iconUrl = safeExternalMentionUrl(span.iconUrl);
        return `<a href="${escapeHtml(externalMentionHref)}" data-mention="external"${iconUrl ? ` data-icon-url="${escapeHtml(iconUrl)}"` : ""}>${html}</a>`;
      }
      const href = safeUrl(span.link);
      if (href) return `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    })
    .join("");
}

function pageWikiLink(label: string, pageId: string | undefined, fallback: string) {
  if (!label && !pageId) return fallback;
  const title = markdownTextLiteral(label || fallback.replace(/^\[\[|\]\]$/g, ""));
  const safePageId = safeMentionId(pageId);
  return safePageId
    ? `[[${title}]](${markdownHref(`/p/${encodeURIComponent(safePageId)}`)})`
    : `[[${title}]]`;
}

/** Serialize styled spans to inline markdown so copy→paste preserves marks. */
function spansToMarkdown(spans?: TextSpan[]): string {
  if (!spans || spans.length === 0) return "";
  return spans
    .map((span) => {
      const date = span.mention === "date" ? safeDateMentionValue(span.date) : undefined;
      const raw = date ? dateMentionDisplayText(date, span.text ?? "") : (span.text ?? "");
      if (!raw) return "";
      // Code suppresses other inline marks.
      if (span.code) {
        return markdownInlineCode(raw);
      }
      // Don't wrap whitespace-only runs (markdown markers need non-space edges).
      if (!raw.trim()) return raw;
      const leading = raw.match(/^\s*/)?.[0] ?? "";
      const trailing = raw.match(/\s*$/)?.[0] ?? "";
      let body = markdownTextLiteral(raw.slice(leading.length, raw.length - trailing.length));
      if (span.bold) body = `**${body}**`;
      if (span.italic) body = `*${body}*`;
      if (span.strikethrough) body = `~~${body}~~`;
      if (date) {
        return `${leading}[${body}](${markdownHref(dateMentionHref(date))})${trailing}`;
      }
      const userId = span.mention === "person" ? safeMentionId(span.userId) : undefined;
      if (userId) {
        return `${leading}[${body}](${markdownHref(personMentionHref(userId))})${trailing}`;
      }
      const pageId = span.mention === "page" ? safeMentionId(span.pageId) : undefined;
      const href = pageId ? `/p/${encodeURIComponent(pageId)}` : safeUrl(span.link);
      if (href) return `${leading}[${body}](${markdownHref(href)})${trailing}`;
      return `${leading}${body}${trailing}`;
    })
    .join("");
}

function markdownTable(table: unknown) {
  const rows =
    Array.isArray(table) && table.length > 0
      ? table.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [""]))
      : [["", ""], ["", ""]];
  const colCount = Math.max(2, ...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: colCount }, (_, index) =>
      markdownTextLiteral(String(row[index] ?? "")).replace(/\|/g, "\\|").replace(/\n/g, "<br>")
    )
  );
  const header = normalized[0] ?? Array.from({ length: colCount }, () => "");
  const body = normalized.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function clipboardTableHtml(table: unknown) {
  const rows =
    Array.isArray(table) && table.length > 0
      ? table.map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : [""]))
      : [["", ""], ["", ""]];
  const colCount = Math.max(2, ...rows.map((row) => row.length));
  const normalized = rows.map((row) =>
    Array.from({ length: colCount }, (_, index) => escapeHtml(String(row[index] ?? ""))).map(
      (cell) => cell.replace(/\n/g, "<br>")
    )
  );
  const header = normalized[0] ?? Array.from({ length: colCount }, () => "");
  const body = normalized.slice(1);
  return [
    '<table style="border-collapse: collapse; width: 100%; margin: 4px 0;">',
    "<thead><tr>",
    ...header.map(
      (cell) =>
        `<th style="border: 1px solid rgba(55, 53, 47, 0.16); padding: 4px 8px; text-align: left; background: rgb(247, 247, 245);">${cell}</th>`
    ),
    "</tr></thead>",
    "<tbody>",
    ...body.map(
      (row) =>
        `<tr>${row
          .map(
            (cell) =>
              `<td style="border: 1px solid rgba(55, 53, 47, 0.16); padding: 4px 8px;">${cell}</td>`
          )
          .join("")}</tr>`
    ),
    "</tbody></table>",
  ].join("");
}

function blockTextHtml(block: Block) {
  if (block.type === "code") {
    return escapeHtml(spansToPlainText(block.content?.rich).trimEnd());
  }
  return clipboardInlineHtml(block.content?.rich);
}

function blockColorStyle(block: Block) {
  return clipboardStyle(block.content?.color, true);
}

function pageLinkHtml(block: Block, fallback: string) {
  const title = escapeHtml(block.plainText?.trim() || fallback);
  const pageId = safeMentionId(block.content?.childPageId);
  if (!pageId) return title;
  return `<a href="/p/${escapeHtml(encodeURIComponent(pageId))}" data-mention="page" data-page-id="${escapeHtml(pageId)}">${title}</a>`;
}

function tabLabelHtml(block: Block, childrenHtml: string) {
  const icon = typeof block.content?.icon === "string" ? block.content.icon.trim() : "";
  const iconAttr = icon ? ` data-notionlike-tab-icon="${escapeHtml(icon)}"` : "";
  const iconHtml = icon
    ? `<span data-notionlike-tab-icon-text="true">${escapeHtml(icon)}</span> `
    : "";
  const titleHtml = blockTextHtml(block) || escapeHtml(block.plainText?.trim() || "Untitled");
  return `<section data-notionlike-tab-label="true"${iconAttr}><p data-notionlike-tab-title="true">${iconHtml}${titleHtml}</p>${childrenHtml ? `<div data-notionlike-tab-panel="true">${childrenHtml}</div>` : ""}</section>`;
}

function blockHtml(block: Block, childrenHtml: string) {
  const text = blockTextHtml(block);
  const style = blockColorStyle(block);
  switch (block.type) {
    case "heading_1":
      return `<h1${style}>${text}</h1>${childrenHtml}`;
    case "heading_2":
      return `<h2${style}>${text}</h2>${childrenHtml}`;
    case "heading_3":
      return `<h3${style}>${text}</h3>${childrenHtml}`;
    case "heading_4":
      return `<h4${style}>${text}</h4>${childrenHtml}`;
    case "toggle_heading_1":
      return `<details open${style}><summary><h1 style="display: inline;">${text}</h1></summary>${childrenHtml}</details>`;
    case "toggle_heading_2":
      return `<details open${style}><summary><h2 style="display: inline;">${text}</h2></summary>${childrenHtml}</details>`;
    case "toggle_heading_3":
      return `<details open${style}><summary><h3 style="display: inline;">${text}</h3></summary>${childrenHtml}</details>`;
    case "toggle_heading_4":
      return `<details open${style}><summary><h4 style="display: inline;">${text}</h4></summary>${childrenHtml}</details>`;
    case "bulleted_list_item":
      return `<ul${style}><li>${text}${childrenHtml}</li></ul>`;
    case "numbered_list_item":
      return `<ol${style}><li>${text}${childrenHtml}</li></ol>`;
    case "to_do":
      return `<ul${style}><li><input type="checkbox" disabled${
        block.content?.checked ? " checked" : ""
      }> ${text}${childrenHtml}</li></ul>`;
    case "toggle":
      return `<details open${style}><summary>${text}</summary>${childrenHtml}</details>`;
    case "quote":
      return `<blockquote${style}>${text}${childrenHtml}</blockquote>`;
    case "callout":
      return `<blockquote${style}><span>${escapeHtml(block.content?.icon ?? "💡")}</span> ${text}${childrenHtml}</blockquote>`;
    case "code": {
      const language = String(block.content?.language ?? "").replace(/[^\w-]/g, "");
      return `<pre${style}><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${text}</code></pre>${childrenHtml}`;
    }
    case "equation":
      return `<p${style}>${escapeHtml(block.content?.expression ?? spansToPlainText(block.content?.rich))}</p>${childrenHtml}`;
    case "divider":
      return `<hr>${childrenHtml}`;
    case "simple_table":
      return `${clipboardTableHtml(block.content?.table)}${childrenHtml}`;
    case "image": {
      const src = safeUrl(block.content?.url);
      const caption = clipboardInlineHtml(block.content?.caption);
      return `${src ? `<figure${style}><img src="${escapeHtml(src)}" alt="${escapeHtml(spansToPlainText(block.content?.caption))}">${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>` : ""}${childrenHtml}`;
    }
    case "video":
    case "audio":
    case "bookmark":
    case "embed":
    case "file": {
      const href = safeUrl(block.content?.url);
      const label =
        block.content?.fileName ||
        block.plainText ||
        (block.type === "bookmark" ? block.content?.url : block.type);
      return `<p${style}>${
        href ? `<a href="${escapeHtml(href)}">${escapeHtml(label ?? "")}</a>` : escapeHtml(label ?? "")
      }</p>${childrenHtml}`;
    }
    case "child_page":
    case "link_to_page":
      return `<p${style}>${pageLinkHtml(block, "Page")}</p>${childrenHtml}`;
    case "child_database":
    case "inline_database":
      return `<p${style}>${pageLinkHtml(block, "Database")}</p>${childrenHtml}`;
    case "button":
      return `<p${style}>${escapeHtml(block.content?.buttonLabel ?? block.plainText ?? "New button")}</p>${childrenHtml}`;
    case "table_of_contents":
      return `<p${style}>Table of contents</p>${childrenHtml}`;
    case "breadcrumb":
      return `<p${style}>Breadcrumb</p>${childrenHtml}`;
    case "synced_block":
      return `<p${style}>Synced block</p>${childrenHtml}`;
    case "tab":
      return `<div${style} data-notionlike-block-type="tab"><strong>Tabs</strong>${childrenHtml}</div>`;
    case "column_list":
      return `<div style="display: flex; gap: 24px; align-items: flex-start;">${childrenHtml}</div>`;
    case "column":
      return `<div style="flex: ${Math.max(0.05, block.content?.width ?? 1)} 1 0;">${childrenHtml}</div>`;
    default:
      return `<p${style}>${text}</p>${childrenHtml}`;
  }
}

export function blockMarkdown(block: Block) {
  // Code blocks keep their content verbatim; everything else keeps inline marks.
  const text =
    block.type === "code"
      ? spansToPlainText(block.content?.rich)
      : spansToMarkdown(block.content?.rich).trimEnd();
  switch (block.type) {
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "heading_4":
      return `#### ${text}`;
    case "toggle_heading_1":
      return `▶ # ${text}`;
    case "toggle_heading_2":
      return `▶ ## ${text}`;
    case "toggle_heading_3":
      return `▶ ### ${text}`;
    case "toggle_heading_4":
      return `▶ #### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `1. ${text}`;
    case "to_do":
      return `- [${block.content?.checked ? "x" : " "}] ${text}`;
    case "toggle":
      return `▶ ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `> ${block.content?.icon ?? "💡"} ${text}`;
    case "code":
      return markdownCodeBlock(text, block.content?.language);
    case "equation":
      return `$$\n${block.content?.expression ?? text}\n$$`;
    case "divider":
      return "---";
    case "simple_table":
      return markdownTable(block.content?.table);
    case "image": {
      const url = safeUrl(block.content?.url);
      return url
        ? `![${markdownTextLiteral(spansToPlainText(block.content?.caption))}](${markdownHref(url)})`
        : "";
    }
    case "video": {
      const url = safeUrl(block.content?.url);
      return url ? `[Video](${markdownHref(url)})` : "[Video]";
    }
    case "audio": {
      const url = safeUrl(block.content?.url);
      return url ? `[Audio](${markdownHref(url)})` : "[Audio]";
    }
    case "bookmark": {
      const url = safeUrl(block.content?.url);
      return url ? `[${markdownTextLiteral(url)}](${markdownHref(url)})` : "";
    }
    case "embed": {
      const url = safeUrl(block.content?.url);
      return url ? `[Embed](${markdownHref(url)})` : "[Embed]";
    }
    case "file": {
      const url = safeUrl(block.content?.url);
      return url
        ? `[File: ${markdownTextLiteral(block.content?.fileName || "File")}](${markdownHref(url)})`
        : markdownTextLiteral(block.content?.fileName || "File");
    }
    case "child_page":
    case "link_to_page":
      return pageWikiLink(block.plainText ?? "", block.content?.childPageId, "[[Page]]");
    case "child_database":
    case "inline_database":
      return pageWikiLink(block.plainText ?? "", block.content?.childPageId, "[[Database]]");
    case "button":
      return `[Button: ${markdownTextLiteral(block.content?.buttonLabel ?? block.plainText ?? "New button")}]`;
    case "table_of_contents":
      return "[Table of contents]";
    case "breadcrumb":
      return "[Breadcrumb]";
    case "synced_block":
      return "[Synced block]";
    case "tab":
      return "[Tabs]";
    default:
      return text;
  }
}

function tabLabelMarkdown(block: Block) {
  const icon = typeof block.content?.icon === "string" ? block.content.icon.trim() : "";
  if (!icon) return "";
  const label = blockMarkdown(block).trim() || "Untitled";
  return `[Tab: ${markdownTextLiteral(icon)} ${label}]`;
}

export function blockTreeMarkdown(root: Block, blocks: Block[]) {
  const childrenOf = (id: string) =>
    blocks
      .filter((candidate) => candidate.parentId === id)
      .sort((a, b) => a.position - b.position);
  const lines: string[] = [];
  const collect = (block: Block, depth: number, parent?: Block) => {
    const markdown =
      parent?.type === "tab" && block.type === "paragraph"
        ? tabLabelMarkdown(block) || blockMarkdown(block)
        : blockMarkdown(block);
    if (markdown) {
      const indent = "  ".repeat(depth);
      lines.push(
        markdown
          .split("\n")
          .map((line) => `${indent}${line}`)
          .join("\n")
      );
    }
    childrenOf(block.id).forEach((child) => collect(child, depth + 1, block));
  };

  collect(root, 0);
  return lines.join("\n");
}

export function blockTreeHtml(root: Block, blocks: Block[]) {
  const childrenOf = (id: string) =>
    blocks
      .filter((candidate) => candidate.parentId === id)
      .sort((a, b) => a.position - b.position);
  const collect = (block: Block, parent?: Block): string => {
    const children = childrenOf(block.id).map((child) => collect(child, block)).join("");
    if (parent?.type === "tab" && block.type === "paragraph") {
      return tabLabelHtml(block, children);
    }
    return blockHtml(block, children);
  };

  return collect(root);
}

export function blocksClipboardHtml(innerHtml: string) {
  return `<html><body><!--StartFragment--><div data-notionlike-copy="true">${innerHtml}</div><!--EndFragment--></body></html>`;
}
