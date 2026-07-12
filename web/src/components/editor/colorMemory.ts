const LAST_COLOR_KEY = "hanji:last-editor-color";

const COLOR_TOKENS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
  "gray_background",
  "brown_background",
  "orange_background",
  "yellow_background",
  "green_background",
  "blue_background",
  "purple_background",
  "pink_background",
  "red_background",
]);

const FALLBACK_COLOR = "yellow_background";

export function isEditorColorToken(token: string) {
  return COLOR_TOKENS.has(token);
}

export function getLastEditorColor() {
  if (typeof window === "undefined") return FALLBACK_COLOR;
  try {
    const token = window.localStorage.getItem(LAST_COLOR_KEY) ?? "";
    return isEditorColorToken(token) ? token : FALLBACK_COLOR;
  } catch {
    return FALLBACK_COLOR;
  }
}

export function rememberEditorColor(token: string) {
  if (!isEditorColorToken(token) || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_COLOR_KEY, token);
  } catch {
    /* ignore */
  }
}
