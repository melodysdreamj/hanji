import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app/globals.css";
import { startLocalBundleFreshnessWatch } from "@/lib/devBundleFreshness";
import { registerServiceWorker } from "@/lib/serviceWorker";
import { applyTheme, getThemePref } from "@/lib/theme";
import { isKoreanLocale } from "@/lib/i18n";

applyTheme(getThemePref());
document.documentElement.lang = isKoreanLocale() ? "ko" : "en";
startLocalBundleFreshnessWatch();
registerServiceWorker();

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
