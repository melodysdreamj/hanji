import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Placement guard for the required AGPL / Sponsor Banner Exception legal notice.
//
// The notice used to float over page content as a fixed pill in the bottom-right
// corner (mounted globally beside the root ErrorBoundary). That overlapped real
// content, so it now lives in normal document flow: small and inline at the
// bottom of the sidebar footer for signed-in users, and on the sign-in screen
// for signed-out users. This guard keeps the intrusive floating mount from
// coming back while ensuring the notice stays present on both surfaces.
//
// Runtime coverage that the sign-in surface actually renders the notice lives in
// AuthGate.test.tsx.

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8");

describe("legal notice placement", () => {
  it("does not float the legal notice over app content at the App root", () => {
    const app = source("src/App.tsx");
    expect(app).not.toContain("<LegalNotice");
    expect(app).not.toContain('from "@/components/LegalNotice"');
  });

  it("renders the notice inline in the sidebar footer", () => {
    const sidebar = source("src/components/Sidebar.tsx");
    expect(sidebar).toContain('import { LegalNotice } from "./LegalNotice"');
    // Inline variant lives inside the footer block, after the new-page button.
    const footer = sidebar.slice(sidebar.indexOf("data-sidebar-footer"));
    expect(footer).toContain("<LegalNotice inline");
  });

  it("renders the notice inline on the sign-in screen", () => {
    const authGate = source("src/components/AuthGate.tsx");
    expect(authGate).toContain('import { LegalNotice } from "./LegalNotice"');
    expect(authGate).toContain("<LegalNotice inline />");
  });
});
