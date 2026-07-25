import "@/lib/legacyNamespace";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app/globals.css";
import { startLocalBundleFreshnessWatch } from "@/lib/devBundleFreshness";
import { registerServiceWorker } from "@/lib/serviceWorker";
import { applyTheme, getThemePref } from "@/lib/theme";
import { initI18n } from "@/i18n";
import { currentSessionUserIdHint, restoreAuthSessionRemote } from "@/lib/edgebase";
import { startInitialAuthRestore } from "@/lib/appStartup";

applyTheme(getThemePref());
startLocalBundleFreshnessWatch();
registerServiceWorker();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

const sessionUserIdHint = currentSessionUserIdHint();
const initialAuthRestore = startInitialAuthRestore(
  window.location.pathname,
  sessionUserIdHint,
  restoreAuthSessionRemote,
);

// The HTML-owned shell paints before catalogs settle. React still waits so
// migrated surfaces never expose raw keys, while the compatible cookie-session
// refresh above overlaps that catalog work and has one explicit owner.
const renderApp = () =>
  createRoot(rootElement).render(
    <StrictMode>
      <App initialAuthRestore={initialAuthRestore} />
    </StrictMode>
  );

void initI18n(sessionUserIdHint).then(renderApp, renderApp);
