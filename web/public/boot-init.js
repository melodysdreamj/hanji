/* global document, localStorage, location */

(() => {
  const html = document.documentElement;
  const publicShare =
    location.pathname === "/share" || location.pathname.startsWith("/share/");
  html.dataset.hanjiBootRoute = publicShare ? "public-share" : "private";

  let warm = false;
  if (!publicShare) {
    try {
      const lastUserId = (localStorage.getItem("hanji.lastUserId") || "").trim();
      for (let index = 0; lastUserId && index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.endsWith(":cookie-session")) continue;
        let marker;
        try {
          marker = JSON.parse(localStorage.getItem(key) || "null");
        } catch {
          // One retired/corrupt namespace must not hide a later matching marker.
          continue;
        }
        if (marker?.version === 1 && marker.userId === lastUserId) {
          warm = true;
          break;
        }
      }
    } catch {
      // Storage can be blocked or contain a stale marker. A visible cold shell
      // is the safe fallback; it never grants cache or remote authority.
    }
  }
  html.dataset.hanjiBootWarm = warm ? "true" : "false";

  const credits = [
    ["Cloudflare", "https://www.cloudflare.com"],
    ["Claude", "https://claude.com"],
    ["ChatGPT", "https://openai.com"],
    ["GLM", "https://z.ai"],
    ["GitHub", "https://github.com"],
  ];

  document.addEventListener("DOMContentLoaded", () => {
    const shell = document.querySelector('[data-testid="pre-i18n-loading"]');
    if (shell) {
      shell.setAttribute("data-kind", publicShare ? "public-share" : "private");
    }
    const link = document.querySelector("[data-hanji-boot-credit-link]");
    if (!link || link.tagName !== "A") return;
    const slot = credits[Math.floor(Math.random() * credits.length)] || credits[0];
    link.textContent = slot[0];
    link.setAttribute("href", slot[1]);
  }, { once: true });
})();
