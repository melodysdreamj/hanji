// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { spansToHtml } from "@/components/editor/richtext";
import type { TextSpan } from "@/lib/types";

// Regression guard for the caret-destroying innerHTML reassignment: the block
// editor's sync effect skips reassigning innerHTML while `el.innerHTML` already
// renders the spans. escapeHtml escapes ' → &#39; and " → &quot;, which the
// browser does NOT do when serializing text content, so a naive
// `el.innerHTML !== spansToHtml(...)` compare mismatched on every keystroke for
// any block containing an apostrophe/quote/nbsp and reset the caret. The fix
// canonicalizes spansToHtml through a detached element; this test locks the
// property that its canonical serialization matches the browser's serialization
// of the same text, so the guard is a true no-op while typing.
function canonical(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.innerHTML;
}

function domHtmlForText(text: string): string {
  const el = document.createElement("div");
  el.textContent = text;
  return el.innerHTML;
}

describe("editable HTML round-trip (caret-preservation guard)", () => {
  it.each([
    "plain text",
    "don't",
    "it's a \"test\"",
    "a b", // non-breaking space
    "5 < 6 && 7 > 3",
    "mix: don't say \"hi\" there < ok >",
  ])("spansToHtml canonicalizes to the browser's serialization for %j", (text) => {
    const spans: TextSpan[] = [{ text }];
    // What the sync effect compares: canonical(spansToHtml) must equal the DOM
    // serialization the browser produced from the same text — else it reassigns.
    expect(canonical(spansToHtml(spans))).toBe(domHtmlForText(text));
  });

  it("still escapes for safety in the raw (pre-canonical) output", () => {
    // The stored/rendered HTML must remain safe — a lone '<' is escaped.
    expect(spansToHtml([{ text: "<script>" }])).toContain("&lt;script&gt;");
  });
});
