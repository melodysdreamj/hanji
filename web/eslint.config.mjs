import js from "@eslint/js";
import globals from "globals";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Service worker: classic script with worker globals.
    files: ["public/sw.js"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    // Build/postbuild scripts run under node.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      "jsx-a11y": jsxA11y,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // Hanji deliberately moves focus into newly opened dialogs, menus, and
      // inline editors. That focus choreography is covered by interaction tests;
      // the blanket rule cannot distinguish it from unexpected page-load focus.
      "jsx-a11y/no-autofocus": "off",
      // Keyboard/mousedown handlers on semantic containers are command or drag
      // delegation (for example Escape on a dialog and arrows inside a grid),
      // not evidence that the container itself is a standalone widget. Keep
      // both rules strict for click handlers; click controls still need native
      // semantics or an explicit interactive role and keyboard equivalent.
      "jsx-a11y/no-noninteractive-element-interactions": [
        "error",
        { handlers: ["onClick"] },
      ],
      "jsx-a11y/no-static-element-interactions": [
        "error",
        { handlers: ["onClick"], allowExpressionValues: true },
      ],
      // A focusable ARIA separator is the standard splitter pattern, and the
      // editor's roving selection anchor is a focusable composite group.
      "jsx-a11y/no-noninteractive-tabindex": [
        "error",
        { roles: ["tabpanel", "separator", "group"], allowExpressionValues: true },
      ],
      // A figcaption remains the semantic caption container while its
      // contentEditable surface acts as the user-editable textbox.
      "jsx-a11y/no-noninteractive-element-to-interactive-role": [
        "error",
        {
          ul: ["listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid"],
          ol: ["listbox", "menu", "menubar", "radiogroup", "tablist", "tree", "treegrid"],
          li: ["menuitem", "option", "row", "tab", "treeitem"],
          table: ["grid"],
          td: ["gridcell"],
          figcaption: ["textbox"],
        },
      ],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "no-control-regex": "off",
      "no-useless-escape": "off",
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='db']",
          message:
            "Browser code must use Hanji backend functions instead of direct EdgeBase db() access.",
        },
        {
          selector: "CallExpression[callee.property.name='table']",
          message:
            "Browser code must use Hanji backend functions instead of direct EdgeBase table() access.",
        },
      ],
    },
  },
  {
    files: ["src/components/editor/BlockItem.tsx"],
    rules: {
      // Audio/video blocks render arbitrary user-provided media URLs. Hanji
      // cannot synthesize a truthful caption track for that external content.
      "jsx-a11y/media-has-caption": "off",
    },
  }
);
