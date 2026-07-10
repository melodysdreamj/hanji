import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

describe("frontend structural guards", () => {
  it("keeps one app-shell main landmark and allows browser zoom", () => {
    const index = source("index.html");
    expect(index).toContain('<title>Hanji</title>');
    expect(index).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/i);

    for (const file of [
      "src/components/HomeView.tsx",
      "src/components/TrashView.tsx",
      "src/components/SharedPageView.tsx",
      "src/components/WorkspaceSettingsDialog.tsx",
    ]) {
      const contents = source(file);
      expect(contents, file).not.toMatch(/<main\b|role=["']main["']/);
    }
  });

  it("keeps walkthrough controls exposed to assistive technology", () => {
    const guide = source("src/components/NotionTokenGuide.tsx");
    expect(guide).not.toMatch(/progressRow[^>]*aria-hidden/);
    expect(guide).toContain('aria-current={index === scene ? "step" : undefined}');
  });

  it("isolates the mobile drawer and top-level dialogs from background focus", () => {
    const shell = source("src/components/AppShell.tsx");
    const sidebar = source("src/components/Sidebar.tsx");
    expect(shell).toContain('data-app-main="true"');
    expect(shell).toContain("inert={shellBackgroundInert ? true : undefined}");
    expect(sidebar).toContain('role={mobile ? "dialog" : undefined}');
    expect(sidebar).toContain("aria-modal={mobile && interactive ? true : undefined}");
    expect(sidebar).toContain('if (event.key === "Escape")');
    expect(sidebar).toContain("main.inert = true");
  });

  it("defines every shared semantic CSS token used without a fallback", () => {
    const globals = source("src/app/globals.css");
    for (const token of [
      "--bg-default",
      "--bg-secondary",
      "--border-subtle",
      "--danger",
      "--focus-ring",
      "--shadow-popover",
      "--shadow-small",
      "--surface-default",
      "--surface-hover",
      "--text-disabled",
      "--text-primary",
    ]) {
      expect(globals, token).toMatch(new RegExp(`${token.replace("--", "--")}\\s*:`));
    }
  });

  it("guards the page tree against whole-store subscriptions and multi-tab-stop rows", () => {
    const tree = source("src/components/PageTreeItem.tsx");
    expect(tree).not.toContain("const pagesById = useStore((s) => s.pagesById)");
    expect(tree).not.toContain("const blocksByPage = useStore((s) => s.blocksByPage)");
    expect(tree).toContain("row.tabIndex = row === event.currentTarget ? 0 : -1");
    expect(tree).not.toMatch(/role="treeitem"[\s\S]{0,120}tabIndex=\{0\}/);
  });

  it("starts local-first sign-out before clearing private caches and never waits on network flushes", () => {
    const sidebar = source("src/components/Sidebar.tsx");
    const signOutBody = sidebar.match(/async function signOut\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(signOutBody).not.toContain("flushAllPending");
    expect(signOutBody.indexOf("signOutRemote()"))
      .toBeGreaterThanOrEqual(0);
    expect(signOutBody.indexOf("signOutRemote()"))
      .toBeLessThan(signOutBody.indexOf("clearDurableOutboxOnSignOut()"));
  });

  it("keeps empty/shared routes localized and native filename filtering text-safe", () => {
    for (const file of ["src/components/HomeView.tsx", "src/components/SharedPageView.tsx"]) {
      const contents = source(file);
      expect(contents, file).toContain('import { pickLabels } from "@/lib/i18n"');
      expect(contents, file).toContain("ko:");
    }

    const nativeExport = source("src/components/nativeExport.ts");
    expect(nativeExport).not.toContain("\u0000");
    expect(nativeExport).toContain("\\u0000-\\u001f");
  });
});
