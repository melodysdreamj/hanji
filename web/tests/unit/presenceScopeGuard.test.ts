import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Guard for the presence email-label disclosure (reviewed as a false positive):
// presence broadcasts a member's email label, but that is only ever delivered to
// same-workspace authenticated peers because presence is DISABLED on the only
// non-member view path (public/read-only shared pages). These two invariants keep
// it a non-issue; if either regresses, an out-of-workspace viewer could join the
// room and receive member email labels.
const webSrc = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

describe("page presence is disabled for public/read-only viewers (#27)", () => {
  it("PageView gates presenceEnabled on !publicReadOnly", () => {
    const source = readFileSync(resolve(webSrc, "components/PageView.tsx"), "utf8");
    const match = source.match(/const presenceEnabled\s*=\s*([^;]+);/);
    expect(match, "presenceEnabled derivation not found").toBeTruthy();
    expect(match![1]).toContain("!publicReadOnly");
  });

  it("usePagePresence bails out before joining the room when not enabled", () => {
    const source = readFileSync(resolve(webSrc, "lib/pagePresence.ts"), "utf8");
    // The effect must early-return when presence is not enabled (or has no
    // workspace), so a disabled viewer never joins the room or receives labels.
    expect(source).toMatch(/if \(!enabled \|\| !pageId \|\| !workspaceId\) \{/);
  });
});
