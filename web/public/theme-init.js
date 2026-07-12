/* global document, localStorage, matchMedia */

(() => {
  try {
    const pref = localStorage.getItem("hanji:theme") || "system";
    const dark =
      pref === "dark" ||
      (pref === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    const theme = dark ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", dark ? "#191919" : "#efe9dc");
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
