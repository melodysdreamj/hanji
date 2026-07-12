import type { DbProperty, Page } from "@/lib/types";
import {
  FORMULA_FUNCTIONS,
  FORMULA_LITERALS,
  evaluateFormulaExpression,
  formulaVariableNames,
  formatFormulaValue as formatFormulaCoreValue,
  tokenizeFormula,
  type FormulaValue,
} from "../../../../shared/database/formula-core";
import { displayPropertyValue } from "./rollup";

function rawValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  return row.properties?.[prop.id];
}

export function evaluateFormula({
  row,
  prop,
  props,
  pagesById,
}: {
  row: Page;
  prop: DbProperty;
  props: DbProperty[];
  pagesById: Record<string, Page>;
}): FormulaValue {
  const expression = prop.config?.formula?.trim();
  if (!expression) return "";
  return evaluateFormulaExpression(expression, (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === prop.id) return "";
    const value = rawValue(row, target);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value == null) return "";
    if (target.type === "number" || target.type === "checkbox") return value as FormulaValue;
    if (target.type === "date") {
      if (typeof value === "string") return value;
      if (value && typeof value === "object") {
        const item = value as { start?: unknown; end?: unknown };
        if (typeof item.start === "string" && typeof item.end === "string" && item.end) {
          return `${item.start}/${item.end}`;
        }
        return typeof item.start === "string" ? item.start : "";
      }
    }
    return displayPropertyValue(row, target, pagesById);
  });
}

/**
 * Static checks for a formula expression so the editor can surface problems
 * instead of silently rendering blank.
 */
export function formulaWarnings(
  expression: string | undefined,
  props: DbProperty[]
): string[] {
  const expr = expression?.trim();
  if (!expr) return [];
  const warnings: string[] = [];
  const names = new Set(props.map((p) => p.name.toLowerCase()));
  const ids = new Set(props.map((p) => p.id));
  const tokens = tokenizeFormula(expr);
  const variables = formulaVariableNames(tokens);
  const seenWarnings = new Set<string>();
  const pushWarning = (warning: string) => {
    if (seenWarnings.has(warning)) return;
    seenWarnings.add(warning);
    warnings.push(warning);
  };

  tokens.forEach((token, index) => {
    if (token.type !== "identifier") return;
    const isCall = tokens[index + 1]?.type === "paren" && tokens[index + 1]?.value === "(";
    if (isCall) {
      if (!FORMULA_FUNCTIONS.has(token.value)) {
        pushWarning(`Unsupported formula function "${token.value}"`);
      }
      if (token.value === "prop") {
        const ref = tokens[index + 2]?.type === "string" ? tokens[index + 2]?.value : "";
        if (ref && !names.has(ref.toLowerCase()) && !ids.has(ref)) {
          pushWarning(`Unknown property "${ref}"`);
        }
      }
    } else if (!FORMULA_LITERALS.has(token.value) && !variables.has(token.value)) {
      pushWarning(`Unsupported formula identifier "${token.value}"`);
    }
  });

  let depth = 0;
  for (const token of tokens) {
    if (token.type !== "paren") continue;
    if (token.value === "(") depth++;
    else if (token.value === ")") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) pushWarning("Unbalanced parentheses");
  return warnings;
}

export function formatFormulaValue(value: FormulaValue) {
  return formatFormulaCoreValue(value);
}
