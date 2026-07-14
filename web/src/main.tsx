import "@/lib/legacyNamespace";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app/globals.css";
import { startLocalBundleFreshnessWatch } from "@/lib/devBundleFreshness";
import { registerServiceWorker } from "@/lib/serviceWorker";
import { applyTheme, getThemePref } from "@/lib/theme";
import { initI18n } from "@/i18n";
import { currentSessionUserIdHint } from "@/lib/edgebase";

applyTheme(getThemePref());
startLocalBundleFreshnessWatch();
registerServiceWorker();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

// Load the active language's catalogs before first paint so migrated surfaces
// render translated (not raw keys). i18next resolves synchronously afterward;
// on failure we still render — untranslated surfaces fall back to English.
const renderApp = () =>
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>
  );

void initI18n(currentSessionUserIdHint()).then(renderApp, renderApp);
