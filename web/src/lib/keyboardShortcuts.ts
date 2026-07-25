export type KeyboardShortcutPlatform = "mac" | "windows" | "linux";
export type KeyboardShortcutCategory = "popular" | "createStyle" | "editMove";
export type KeyboardShortcutScope = "global" | "page" | "editor";
export type KeyboardShortcutId =
  | "openKeyboardShortcuts"
  | "newPage"
  | "quickFind"
  | "findInPage"
  | "copyPageLink"
  | "navigateBack"
  | "navigateForward"
  | "toggleTheme"
  | "openParentPage"
  | "movePage"
  | "toggleSidebar"
  | "bold"
  | "italic"
  | "underline"
  | "strikethrough"
  | "inlineCode"
  | "addLink"
  | "addComment"
  | "moveBlock"
  | "moveBlockUp"
  | "moveBlockDown"
  | "blockColor"
  | "openBlockMenu"
  | "toggleAllToggles";

type ModifierRequirement = boolean | "any";

export type KeyboardShortcutChord = Readonly<{
  key: string;
  code?: string;
  displayKey?: string;
  primary: boolean;
  alt?: ModifierRequirement;
  shift?: ModifierRequirement;
}>;

export type KeyboardShortcutDefinition = Readonly<{
  id: KeyboardShortcutId;
  category: KeyboardShortcutCategory;
  labelKey: `keyboardShortcuts:actions.${string}`;
  searchTermsKey?: `keyboardShortcuts:searchTerms.${string}`;
  scope: KeyboardShortcutScope;
  helpVisible: boolean;
  chords: readonly KeyboardShortcutChord[];
}>;

export type KeyboardShortcutEventLike = {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

const chord = (
  key: string,
  options: Omit<KeyboardShortcutChord, "key" | "primary"> & { primary?: boolean } = {},
): KeyboardShortcutChord => ({
  key,
  primary: options.primary ?? true,
  ...options,
});

export const KEYBOARD_SHORTCUTS = [
  {
    id: "openKeyboardShortcuts",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.openKeyboardShortcuts",
    scope: "global",
    helpVisible: false,
    chords: [chord("/", { code: "Slash", alt: true })],
  },
  {
    id: "newPage",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.newPage",
    scope: "global",
    helpVisible: true,
    chords: [chord("n", { code: "KeyN" })],
  },
  {
    id: "quickFind",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.quickFind",
    scope: "global",
    helpVisible: true,
    chords: [chord("k", { code: "KeyK" }), chord("p", { code: "KeyP" })],
  },
  {
    id: "findInPage",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.findInPage",
    scope: "page",
    helpVisible: true,
    chords: [chord("f", { code: "KeyF" })],
  },
  {
    id: "copyPageLink",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.copyPageLink",
    scope: "global",
    helpVisible: true,
    chords: [chord("l", { code: "KeyL" })],
  },
  {
    id: "navigateBack",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.navigateBack",
    scope: "global",
    helpVisible: true,
    chords: [chord("[", { code: "BracketLeft" })],
  },
  {
    id: "navigateForward",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.navigateForward",
    scope: "global",
    helpVisible: true,
    chords: [chord("]", { code: "BracketRight" })],
  },
  {
    id: "toggleTheme",
    category: "popular",
    labelKey: "keyboardShortcuts:actions.toggleTheme",
    searchTermsKey: "keyboardShortcuts:searchTerms.toggleTheme",
    scope: "global",
    helpVisible: true,
    chords: [chord("l", { code: "KeyL", shift: true })],
  },
  {
    id: "bold",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.bold",
    scope: "editor",
    helpVisible: true,
    chords: [chord("b", { code: "KeyB" })],
  },
  {
    id: "italic",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.italic",
    scope: "editor",
    helpVisible: true,
    chords: [chord("i", { code: "KeyI" })],
  },
  {
    id: "underline",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.underline",
    scope: "editor",
    helpVisible: true,
    chords: [chord("u", { code: "KeyU" })],
  },
  {
    id: "strikethrough",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.strikethrough",
    scope: "editor",
    helpVisible: true,
    chords: [chord("x", { code: "KeyX", shift: true }), chord("s", { code: "KeyS", shift: true })],
  },
  {
    id: "inlineCode",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.inlineCode",
    scope: "editor",
    helpVisible: true,
    chords: [chord("e", { code: "KeyE" })],
  },
  {
    id: "addLink",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.addLink",
    scope: "editor",
    helpVisible: true,
    chords: [chord("k", { code: "KeyK" })],
  },
  {
    id: "addComment",
    category: "createStyle",
    labelKey: "keyboardShortcuts:actions.addComment",
    scope: "editor",
    helpVisible: true,
    chords: [chord("m", { code: "KeyM", shift: true })],
  },
  {
    id: "openParentPage",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.openParentPage",
    scope: "global",
    helpVisible: true,
    chords: [chord("u", { code: "KeyU", shift: true })],
  },
  {
    id: "movePage",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.movePage",
    scope: "global",
    helpVisible: true,
    chords: [chord("p", { code: "KeyP", shift: true })],
  },
  {
    id: "toggleSidebar",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.toggleSidebar",
    scope: "global",
    helpVisible: true,
    chords: [chord("\\", { code: "Backslash", shift: "any" })],
  },
  {
    id: "moveBlock",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.moveBlock",
    scope: "editor",
    helpVisible: true,
    chords: [chord("p", { code: "KeyP", shift: true })],
  },
  {
    id: "moveBlockUp",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.moveBlockUp",
    scope: "editor",
    helpVisible: true,
    chords: [chord("ArrowUp", { shift: true })],
  },
  {
    id: "moveBlockDown",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.moveBlockDown",
    scope: "editor",
    helpVisible: true,
    chords: [chord("ArrowDown", { shift: true })],
  },
  {
    id: "blockColor",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.blockColor",
    scope: "editor",
    helpVisible: true,
    chords: [chord("h", { code: "KeyH", shift: true })],
  },
  {
    id: "openBlockMenu",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.openBlockMenu",
    scope: "editor",
    helpVisible: true,
    chords: [chord("/", { code: "Slash" })],
  },
  {
    id: "toggleAllToggles",
    category: "editMove",
    labelKey: "keyboardShortcuts:actions.toggleAllToggles",
    scope: "page",
    helpVisible: true,
    chords: [chord("t", { code: "KeyT", alt: true })],
  },
] as const satisfies readonly KeyboardShortcutDefinition[];

const shortcutById = new Map<KeyboardShortcutId, KeyboardShortcutDefinition>(
  KEYBOARD_SHORTCUTS.map((shortcut) => [shortcut.id, shortcut]),
);

export function keyboardShortcut(id: KeyboardShortcutId): KeyboardShortcutDefinition {
  const shortcut = shortcutById.get(id);
  if (!shortcut) throw new Error(`Unknown keyboard shortcut: ${id}`);
  return shortcut;
}

export function isComposingKeyEvent(event: KeyboardShortcutEventLike) {
  return Boolean(
    event.isComposing ||
      event.nativeEvent?.isComposing ||
      event.key === "Process" ||
      event.keyCode === 229 ||
      event.nativeEvent?.keyCode === 229
  );
}

function modifierMatches(actual: boolean | undefined, requirement: ModifierRequirement | undefined) {
  if (requirement === "any") return true;
  return Boolean(actual) === Boolean(requirement);
}

function chordMatches(chordDefinition: KeyboardShortcutChord, event: KeyboardShortcutEventLike) {
  const primary = Boolean(event.metaKey || event.ctrlKey);
  if (primary !== chordDefinition.primary) return false;
  if (!modifierMatches(event.altKey, chordDefinition.alt)) return false;
  if (!modifierMatches(event.shiftKey, chordDefinition.shift)) return false;
  const keyMatches = event.key.toLowerCase() === chordDefinition.key.toLowerCase();
  const codeMatches = Boolean(chordDefinition.code && event.code === chordDefinition.code);
  return keyMatches || codeMatches;
}

export function matchesKeyboardShortcut(
  id: KeyboardShortcutId,
  event: KeyboardShortcutEventLike,
) {
  if (event.defaultPrevented || event.repeat || isComposingKeyEvent(event)) return false;
  return keyboardShortcut(id).chords.some((definition) => chordMatches(definition, event));
}

export function detectKeyboardShortcutPlatform(value?: string): KeyboardShortcutPlatform {
  const platform = value ?? (
    typeof navigator === "undefined"
      ? ""
      : `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`
  );
  if (/mac|iphone|ipad|ipod/i.test(platform)) return "mac";
  if (/win/i.test(platform)) return "windows";
  return "linux";
}

function displayKey(chordDefinition: KeyboardShortcutChord) {
  if (chordDefinition.displayKey) return chordDefinition.displayKey;
  if (/^arrow/i.test(chordDefinition.key)) return chordDefinition.key.replace(/^Arrow/i, "");
  return chordDefinition.key.length === 1
    ? chordDefinition.key.toUpperCase()
    : chordDefinition.key;
}

function chordDisplayKeys(
  chordDefinition: KeyboardShortcutChord,
  platform: KeyboardShortcutPlatform,
) {
  const keys: string[] = [];
  if (chordDefinition.primary) keys.push(platform === "mac" ? "Cmd" : "Ctrl");
  if (chordDefinition.alt === true) keys.push(platform === "mac" ? "Option" : "Alt");
  if (chordDefinition.shift === true) keys.push("Shift");
  keys.push(displayKey(chordDefinition));
  return keys;
}

export function shortcutDisplayKeys(
  id: KeyboardShortcutId,
  platform: KeyboardShortcutPlatform = detectKeyboardShortcutPlatform(),
) {
  return keyboardShortcut(id).chords.map((definition) => chordDisplayKeys(definition, platform));
}

export function shortcutCompactLabel(
  id: KeyboardShortcutId,
  platform: KeyboardShortcutPlatform = detectKeyboardShortcutPlatform(),
) {
  const [definition] = keyboardShortcut(id).chords;
  if (!definition) return "";
  if (platform === "mac") {
    const modifiers = [
      definition.primary ? "⌘" : "",
      definition.alt === true ? "⌥" : "",
      definition.shift === true ? "⇧" : "",
    ].join("");
    return `${modifiers}${displayKey(definition)}`;
  }
  return chordDisplayKeys(definition, platform).join("+");
}
