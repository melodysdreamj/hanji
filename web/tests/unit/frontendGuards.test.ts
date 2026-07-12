import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

function sourceFiles(path: string): string[] {
  const absolute = resolve(webRoot, path);
  return readdirSync(absolute).flatMap((name) => {
    const child = resolve(absolute, name);
    if (statSync(child).isDirectory()) return sourceFiles(`${path}/${name}`);
    return /\.[cm]?[jt]sx?$/.test(name) ? [child] : [];
  });
}

const TRANSLATED_JSX_ATTRIBUTES = new Set([
  "alt",
  "aria-description",
  "aria-label",
  "aria-placeholder",
  "ariaLabel",
  "data-placeholder",
  "placeholder",
  "title",
]);
const INTENTIONAL_EDITOR_LITERALS = new Set(["A", "E = mc^2", "Hanji", "i", "https://..."]);

function stringLiterals(path: string, contents: string) {
  const file = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const values = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      values.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return values;
}

function staticUiStrings(expression: ts.Expression): string[] {
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (ts.isTemplateExpression(expression)) {
    return [
      expression.head.text + expression.templateSpans.map((span) => span.literal.text).join(""),
    ];
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...staticUiStrings(expression.whenTrue),
      ...staticUiStrings(expression.whenFalse),
    ];
  }
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return staticUiStrings(expression.expression);
  }
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken,
    ].includes(expression.operatorToken.kind)
  ) {
    return [...staticUiStrings(expression.left), ...staticUiStrings(expression.right)];
  }
  return [];
}

function untranslatedJsxLiterals(path: string, contents: string) {
  const file = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: string[] = [];
  const check = (node: ts.Node, value: string) => {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (!/[A-Za-z]/.test(normalized) || INTENTIONAL_EDITOR_LITERALS.has(normalized)) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    findings.push(`${path}:${line + 1}: ${JSON.stringify(normalized)}`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.getText(file));
    if (
      ts.isJsxAttribute(node) &&
      TRANSLATED_JSX_ATTRIBUTES.has(node.name.getText(file)) &&
      node.initializer
    ) {
      if (ts.isStringLiteral(node.initializer)) check(node, node.initializer.text);
      if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        for (const value of staticUiStrings(node.initializer.expression)) check(node, value);
      }
    }
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent) && node.expression) {
      for (const value of staticUiStrings(node.expression)) check(node, value);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe("frontend structural guards", () => {
  it("does not let the host OS locale change product search case folding", () => {
    const findings = sourceFiles("src")
      .filter((path) => /\.toLocale(?:Lower|Upper)Case\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => path.slice(webRoot.length + 1));
    expect(findings).toEqual([]);
  });

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

  it("applies the saved theme before module execution and exposes maskable PWA icons", () => {
    const index = source("index.html");
    const modulePosition = index.indexOf('type="module"');
    const themePosition = index.indexOf('src="/theme-init.js"');
    expect(themePosition).toBeGreaterThan(0);
    expect(themePosition).toBeLessThan(modulePosition);
    expect(index).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i);
    const themeInit = source("public/theme-init.js");
    expect(themeInit).toContain('localStorage.getItem("hanji:theme")');
    expect(themeInit).toContain("document.documentElement.dataset.theme = theme");
    const precacheGenerator = source("scripts/generate-sw-precache.mjs");
    expect(precacheGenerator).toContain('html.matchAll(/<script[^>]+src=');
    const serviceWorker = source("public/sw.js");
    expect(serviceWorker).toContain("precachedShellAssetNetworkFirst(request)");
    expect(serviceWorker).toContain("manifest.assets.includes(pathname)");

    const manifest = JSON.parse(source("public/manifest.webmanifest")) as {
      id?: string;
      start_url?: string;
      scope?: string;
      icons?: Array<{ purpose?: string }>;
    };
    expect(manifest).toMatchObject({ id: "/", start_url: "/", scope: "/" });
    expect(manifest.icons?.every((icon) => icon.purpose?.includes("maskable"))).toBe(true);
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

  it("keeps mobile page-tree rows on the shared compact geometry", () => {
    const sidebar = source("src/components/Sidebar.module.css");
    expect(sidebar).toMatch(/\.treeRow\s*\{[\s\S]*?height:\s*30px;/);
    expect(sidebar).toMatch(/\.treeLeading\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;[\s\S]*?flex:\s*0 0 20px;/);
    expect(sidebar).toMatch(/\.treeIcon\s*\{[\s\S]*?width:\s*20px;[\s\S]*?height:\s*20px;/);
    expect(sidebar).not.toMatch(/\.sidebar\[data-mobile="true"\]\s+\.tree(?:Row|Leading|Icon)\s*\{/);
    expect(sidebar).toContain("Touch changes reveal behavior, not the compact tree geometry");
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

  it("keeps long Notion discovery alive after the dialog closes and exposes resume", () => {
    const dialog = source("src/components/ImportDialog.tsx");
    expect(dialog).toContain("while (running)");
    expect(dialog).not.toContain("while (running && !closedRef.current)");
    expect(dialog).toContain("async function resumeNotionDiscovery");
    expect(dialog).toContain("activeJob.connectionId");
    expect(dialog).toContain("L.resumeImport");
  });

  it("joins an existing Notion discovery runner instead of duplicating it after reopen", () => {
    const dialog = source("src/components/ImportDialog.tsx");
    expect(dialog).toContain("const notionDiscoveryRunnerCompletions = new Map<string, Promise<void>>()");
    expect(dialog).toContain("const existingRunner = notionDiscoveryRunnerCompletions.get(runnerKey)");
    expect(dialog).toContain("await existingRunner");
    expect(dialog).toContain("notionDiscoveryRunnerCompletions.delete(runnerKey)");
  });

  it("keeps empty/shared routes localized and native filename filtering text-safe", () => {
    for (const file of ["src/components/HomeView.tsx", "src/components/SharedPageView.tsx"]) {
      const contents = source(file);
      expect(contents, file).toContain('import { useTranslation } from "react-i18next"');
      expect(contents, file).toContain("useTranslation(");
      expect(contents, file).not.toContain("pickLabels(");
    }

    const nativeExport = source("src/components/nativeExport.ts");
    expect(nativeExport).not.toContain("\u0000");
    expect(nativeExport).toContain("\\u0000-\\u001f");
  });

  it("keeps editor JSX text and accessible names in translation catalogs", () => {
    const synthetic = untranslatedJsxLiterals(
      "synthetic.tsx",
      '<button aria-label="Save changes" data-placeholder="Type here">Save</button>',
    );
    expect(synthetic).toHaveLength(3);

    const violations = [
      "src/components/editor/BlockItem.tsx",
      "src/components/editor/MermaidPreview.tsx",
    ].flatMap((file) => untranslatedJsxLiterals(file, source(file)));
    expect(violations).toEqual([]);

    const blockItem = source("src/components/editor/BlockItem.tsx");
    expect(blockItem).not.toMatch(/getDef\([^)]*\)\.(?:label|placeholder)/);
  });

  it("keeps database chrome, generated names, and accessible labels in translation catalogs", () => {
    const file = "src/components/database/DatabaseView.tsx";
    const contents = source(file);
    expect(untranslatedJsxLiterals(file, contents)).toEqual([]);

    const literals = stringLiterals(file, contents);
    for (const oldUiLiteral of [
      "Add a view",
      "Add filter",
      "Add filter group",
      "Add select property",
      "Add sort",
      "Add status property",
      "And",
      "Ascending",
      "Board",
      "Boards group by Select or Status.",
      "Calendar",
      "Chart",
      "Checked",
      "Choose how this database should appear.",
      "Choose option",
      "Choose person",
      "Date",
      "Descending",
      "End date",
      "Filter condition",
      "Filter group",
      "Filter property",
      "Gallery",
      "In progress",
      "List",
      "Not started",
      "Only show rows that match rules.",
      "Option 1",
      "Option 2",
      "Order rows by a property.",
      "Property type",
      "Select",
      "Sort direction",
      "Sort property",
      "Status",
      "Table",
      "This Notion view was imported, but the matching renderer is still pending.",
      "Timeline",
      "Unchecked",
      "Undo",
      "Unsupported",
      "Untitled",
    ]) {
      expect(literals.has(oldUiLiteral), oldUiLiteral).toBe(false);
    }

    const editorFile = "src/components/editor/Editor.tsx";
    const editor = source(editorFile);
    const editorLiterals = stringLiterals(editorFile, editor);
    expect(editorLiterals.has("Name"), "browser-created database title property").toBe(false);
    for (const localizedControlName of [
      "Image link",
      "Image caption",
      "Video link",
      "Video caption",
      "Audio link",
      "Audio caption",
      "Bookmark link",
      "Embed link",
      "Embed caption",
      "File link",
      "File caption",
    ]) {
      expect(editorLiterals.has(localizedControlName), localizedControlName).toBe(false);
    }
    expect(editor).toContain('data-block-control="image-link"');
    expect(editor).toContain('data-block-control="file-caption"');
    expect(editor).toContain("plainText: pageDisplayTitle(page)");
    expect(editor).not.toContain('plainText: page.title || "Untitled"');
    expect(editor).toContain("return pageTitle || DEFAULT_DATABASE_TITLE");
    expect(editor).not.toContain("isUntitledPageTitle");
    expect(editor).not.toContain('pageTitle !== "Untitled"');
    expect(editor.match(/const title = databaseTitleFromBlock\(cur\);/g)).toHaveLength(2);
    expect(editor).not.toContain("databaseTitleFromBlock(cur, inlineDatabasePlaceholderTitle())");

    const blockHandleFile = "src/components/editor/BlockHandle.tsx";
    const blockHandle = source(blockHandleFile);
    expect(blockHandle).toContain('data-block-control="${type}-caption"');
    expect(blockHandle).not.toContain("captionLabelFor");

    const storeFile = "src/lib/store.ts";
    const store = source(storeFile);
    expect(stringLiterals(storeFile, store).has("Untitled template")).toBe(false);
    expect(store).toContain('i18next.t("databaseView:copyName"');
    expect(store).toContain('locale: isKoreanLocale() ? "ko" : "en"');
    expect(store).toContain("activePersistentGeneratedLabels().copyName(pageDisplayTitle(source))");
    expect(store).not.toContain('`${pageDisplayTitle(source)} copy`');

    const backend = source("../backend/functions/database-mutation.ts");
    expect(backend).toContain("starterDatabaseLabels(locale)");
    expect(backend).toContain("body.properties, body.locale");
  });

  it("never lets the host OS locale choose persisted UI date or number formatting", () => {
    const forbidden = [
      /\.toLocaleDateString\(\s*(?:undefined\s*)?(?:,|\))/,
      /\.toLocaleString\(\s*(?:undefined\s*)?(?:,|\))/,
      /new\s+Intl\.(?:DateTimeFormat|NumberFormat)\(\s*(?:undefined\s*)?(?:,|\))/,
    ];
    const violations = sourceFiles("src").flatMap((file) => {
      const contents = readFileSync(file, "utf8");
      return forbidden.some((pattern) => pattern.test(contents))
        ? [file.slice(webRoot.length + 1)]
        : [];
    });
    expect(violations).toEqual([]);

    const numberFormatFile = "src/components/database/numberFormat.ts";
    const numberFormatLiterals = stringLiterals(numberFormatFile, source(numberFormatFile));
    for (const oldLabel of ["Number with commas", "Percent", "Dollar", "Won", "Euro"]) {
      expect(numberFormatLiterals.has(oldLabel), oldLabel).toBe(false);
    }
    expect(source("src/components/database/PropertyTypeConfig.tsx"))
      .toContain("propertyTypeConfig:numberFormats.${format}");
  });

  it("binds inline-database icon uploads to the database page", () => {
    const blockItem = source("src/components/editor/BlockItem.tsx");
    expect(blockItem).toMatch(
      /<EmojiPicker\s+placement="inline"\s+uploadTarget=\{\{ pageId: db\.id \}\}\s+onPick=\{\(emoji\) => updateInlineDatabaseIcon/
    );
  });

  it("keeps destructive schema actions release-safe", () => {
    for (const file of [
      "src/components/database/RowProperties.tsx",
      "src/components/database/TableView.tsx",
      "src/components/database/DatabaseView.tsx",
    ]) {
      const contents = source(file);
      expect(contents, file).toContain("window.confirm(");
      expect(contents, file).not.toContain("restoreDeletedProperty");
    }
    for (const file of [
      "src/components/database/PropertyTypeConfig.tsx",
      "src/components/database/PropertyCell.tsx",
      "src/components/database/BoardView.tsx",
    ]) {
      const contents = source(file);
      expect(contents, file).not.toContain("deletePropertyOption");
      expect(contents, file).not.toContain("restoreDeletedPropertyOption");
    }
    const store = source("src/lib/store.ts");
    expect(store).toContain("const CLIENT_SCHEMA_RESTORE_ENABLED = false");
    expect(store).toContain("const CLIENT_PROPERTY_OPTION_DELETE_ENABLED = false");
  });
});
