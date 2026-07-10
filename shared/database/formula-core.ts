export type FormulaValue = string | number | boolean | null;

export type FormulaTokenType =
  | "number"
  | "string"
  | "identifier"
  | "operator"
  | "paren"
  | "comma";

export type FormulaToken = {
  type: FormulaTokenType;
  value: string;
};

export const FORMULA_FUNCTIONS = new Set([
  "prop",
  "if",
  "ifs",
  "let",
  "lets",
  "concat",
  "repeat",
  "format",
  "toNumber",
  "add",
  "subtract",
  "multiply",
  "divide",
  "mod",
  "pow",
  "min",
  "max",
  "sum",
  "mean",
  "median",
  "sqrt",
  "cbrt",
  "exp",
  "ln",
  "log10",
  "log2",
  "sign",
  "pi",
  "e",
  "lower",
  "upper",
  "trim",
  "startsWith",
  "endsWith",
  "substring",
  "replace",
  "replaceAll",
  "test",
  "now",
  "today",
  "dateAdd",
  "dateSubtract",
  "dateBetween",
  "dateRange",
  "parseDate",
  "dateStart",
  "dateEnd",
  "timestamp",
  "fromTimestamp",
  "formatDate",
  "year",
  "month",
  "day",
  "date",
  "week",
  "hour",
  "minute",
  "round",
  "floor",
  "ceil",
  "abs",
  "empty",
  "contains",
  "length",
  "not",
  "and",
  "or",
]);

export const FORMULA_LITERALS = new Set(["true", "false", "null"]);

export function tokenizeFormula(input: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) {
          value += input[i + 1];
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ type: "string", value });
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < input.length && /[0-9.]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: "number", value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ type: "identifier", value });
      continue;
    }
    const two = input.slice(i, i + 2);
    if ([">=", "<=", "==", "!="].includes(two)) {
      tokens.push({ type: "operator", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%^><".includes(ch)) {
      tokens.push({ type: "operator", value: ch });
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      tokens.push({ type: "paren", value: ch });
      i += 1;
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma", value: ch });
      i += 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function toNumber(value: FormulaValue | undefined) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toText(value: FormulaValue | undefined) {
  if (value == null) return "";
  return String(value);
}

function toBoolean(value: FormulaValue | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value !== null && value !== undefined && value !== "";
}

function numberValues(values: FormulaValue[]) {
  return values.map((value) => toNumber(value));
}

function medianValue(values: FormulaValue[]) {
  const numbers = numberValues(values).sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function roundValue(value: FormulaValue | undefined, precisionValue?: FormulaValue) {
  const precision = Math.trunc(toNumber(precisionValue ?? 0));
  const factor = Math.pow(10, precision);
  if (!Number.isFinite(factor) || factor === 0) return Math.round(toNumber(value ?? null));
  return Math.round(toNumber(value ?? null) * factor) / factor;
}

function toIndex(value: FormulaValue | undefined) {
  return Math.max(0, Math.trunc(toNumber(value ?? 0)));
}

function substringValue(value: FormulaValue | undefined, start: FormulaValue | undefined, end?: FormulaValue) {
  const text = toText(value ?? "");
  const from = toIndex(start);
  if (end === undefined || end === null || end === "") return text.slice(from);
  return text.slice(from, Math.max(from, toIndex(end)));
}

function repeatValue(value: FormulaValue | undefined, countValue: FormulaValue | undefined) {
  const count = Math.max(0, Math.min(1000, Math.trunc(toNumber(countValue ?? 0))));
  return toText(value ?? "").repeat(count).slice(0, 10000);
}

function replaceValue(
  value: FormulaValue | undefined,
  patternValue: FormulaValue | undefined,
  replacementValue: FormulaValue | undefined,
  all = false,
) {
  const text = toText(value ?? "");
  const pattern = toText(patternValue ?? "");
  const replacement = toText(replacementValue ?? "");
  if (!pattern) return text;
  try {
    return text.replace(new RegExp(pattern, all ? "g" : ""), replacement);
  } catch {
    return all ? text.split(pattern).join(replacement) : text.replace(pattern, replacement);
  }
}

function testValue(value: FormulaValue | undefined, patternValue: FormulaValue | undefined) {
  const pattern = toText(patternValue ?? "");
  if (!pattern) return false;
  try {
    return new RegExp(pattern).test(toText(value ?? ""));
  } catch {
    return toText(value ?? "").includes(pattern);
  }
}

function dateValue(value: FormulaValue | undefined) {
  const raw = toText(value ?? "").split("/")[0].trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    const second = Number(match[6] ?? 0);
    const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
    const zone = match[8] ?? "";
    const localCandidate = new Date(Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond,
    ));
    if (Number.isNaN(localCandidate.getTime())) return null;
    if (
      localCandidate.getUTCFullYear() !== year ||
      localCandidate.getUTCMonth() !== month - 1 ||
      localCandidate.getUTCDate() !== day ||
      localCandidate.getUTCHours() !== hour ||
      localCandidate.getUTCMinutes() !== minute ||
      localCandidate.getUTCSeconds() !== second ||
      localCandidate.getUTCMilliseconds() !== millisecond
    ) {
      return null;
    }
    if (!zone) return localCandidate;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateEndValue(value: FormulaValue | undefined) {
  const text = toText(value ?? "");
  const end = text.split("/")[1]?.trim();
  return dateValue(end || text);
}

function dateKeyValue(date: Date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function dateTimeKeyValue(date: Date) {
  const dateKey = dateKeyValue(date);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${dateKey}T${hour}:${minute}:${second}Z`;
}

function dateRangeValue(startValue: FormulaValue | undefined, endValue: FormulaValue | undefined) {
  const start = dateValue(startValue);
  const end = dateValue(endValue);
  if (!start || !end) return "";
  return `${dateTimeKeyValue(start)}/${dateTimeKeyValue(end)}`;
}

function isoWeekValue(date: Date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function dateUnit(value: FormulaValue | undefined) {
  const unit = toText(value ?? "days").trim().toLowerCase();
  if (unit === "year" || unit === "years") return "years";
  if (unit === "quarter" || unit === "quarters") return "quarters";
  if (unit === "month" || unit === "months") return "months";
  if (unit === "week" || unit === "weeks") return "weeks";
  if (unit === "hour" || unit === "hours") return "hours";
  if (unit === "minute" || unit === "minutes") return "minutes";
  return "days";
}

function addMonthsUtc(date: Date, months: number) {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function dateAddValue(value: FormulaValue | undefined, amountValue: FormulaValue | undefined, unitValue: FormulaValue | undefined) {
  const date = dateValue(value);
  if (!date) return "";
  const amount = Math.trunc(toNumber(amountValue ?? 0));
  const unit = dateUnit(unitValue);
  let out = new Date(date.getTime());
  if (unit === "years") out = addMonthsUtc(out, amount * 12);
  else if (unit === "quarters") out = addMonthsUtc(out, amount * 3);
  else if (unit === "months") out = addMonthsUtc(out, amount);
  else if (unit === "weeks") out.setUTCDate(out.getUTCDate() + amount * 7);
  else if (unit === "hours") out.setUTCHours(out.getUTCHours() + amount);
  else if (unit === "minutes") out.setUTCMinutes(out.getUTCMinutes() + amount);
  else out.setUTCDate(out.getUTCDate() + amount);
  return dateKeyValue(out);
}

function dateBetweenValue(endValue: FormulaValue | undefined, startValue: FormulaValue | undefined, unitValue: FormulaValue | undefined) {
  const end = dateValue(endValue);
  const start = dateValue(startValue);
  if (!end || !start) return 0;
  const unit = dateUnit(unitValue);
  const days = Math.floor((end.getTime() - start.getTime()) / 86_400_000);
  if (unit === "minutes") return Math.floor((end.getTime() - start.getTime()) / 60_000);
  if (unit === "hours") return Math.floor((end.getTime() - start.getTime()) / 3_600_000);
  if (unit === "weeks") return Math.floor(days / 7);
  const months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) -
    (end.getUTCDate() < start.getUTCDate() ? 1 : 0);
  if (unit === "years") return Math.floor(months / 12);
  if (unit === "quarters") return Math.floor(months / 3);
  if (unit === "months") return months;
  return days;
}

function datePartValue(value: FormulaValue | undefined, part: "year" | "month" | "day") {
  const date = dateValue(value);
  if (!date) return 0;
  if (part === "year") return date.getUTCFullYear();
  if (part === "month") return date.getUTCMonth() + 1;
  return date.getUTCDate();
}

function hourValue(value: FormulaValue | undefined) {
  const date = dateValue(value);
  return date ? date.getUTCHours() : 0;
}

function minuteValue(value: FormulaValue | undefined) {
  const date = dateValue(value);
  return date ? date.getUTCMinutes() : 0;
}

function timestampValue(value: FormulaValue | undefined) {
  const date = dateValue(value);
  return date ? date.getTime() : 0;
}

function fromTimestampValue(value: FormulaValue | undefined) {
  const date = new Date(toNumber(value ?? null));
  return Number.isNaN(date.getTime()) ? "" : dateTimeKeyValue(date);
}

function dateRangeEndpointValue(value: FormulaValue | undefined, endpoint: "start" | "end") {
  const date = endpoint === "end" ? dateEndValue(value) : dateValue(value);
  return date ? dateKeyValue(date) : "";
}

function formatDateValue(value: FormulaValue | undefined, formatValue?: FormulaValue) {
  const date = dateValue(value);
  if (!date) return "";
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const tokens: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    Y: String(date.getUTCFullYear()),
    MMM: monthNames[date.getUTCMonth()],
    MM: String(date.getUTCMonth() + 1).padStart(2, "0"),
    M: String(date.getUTCMonth() + 1),
    DD: String(date.getUTCDate()).padStart(2, "0"),
    D: String(date.getUTCDate()),
    h: String(date.getUTCHours()),
    HH: String(date.getUTCHours()).padStart(2, "0"),
    mm: String(date.getUTCMinutes()).padStart(2, "0"),
  };
  const format = toText(formatValue ?? "YYYY-MM-DD") || "YYYY-MM-DD";
  return format.replace(/YYYY|MMM|HH|MM|DD|mm|Y|M|D|h/g, (token) => tokens[token] ?? token);
}

function add(a: FormulaValue, b: FormulaValue): FormulaValue {
  if (typeof a === "string" || typeof b === "string") return `${toText(a)}${toText(b)}`;
  return toNumber(a) + toNumber(b);
}

function callArguments(tokens: FormulaToken[], openIndex: number): FormulaToken[][] {
  const args: FormulaToken[][] = [];
  let current: FormulaToken[] = [];
  let depth = 0;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "paren" && token.value === "(") {
      depth += 1;
      current.push(token);
      continue;
    }
    if (token.type === "paren" && token.value === ")") {
      if (depth === 0) {
        args.push(current);
        return args;
      }
      depth -= 1;
      current.push(token);
      continue;
    }
    if (token.type === "comma" && depth === 0) {
      args.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  return args;
}

function variableNameFromArg(tokens: FormulaToken[]) {
  if (tokens.length !== 1) return "";
  const token = tokens[0];
  if (token.type !== "identifier" && token.type !== "string") return "";
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value) ? token.value : "";
}

export function formulaVariableNames(tokens: FormulaToken[]) {
  const variables = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.type !== "identifier" || (token.value !== "let" && token.value !== "lets")) return;
    if (tokens[index + 1]?.type !== "paren" || tokens[index + 1]?.value !== "(") return;
    const args = callArguments(tokens, index + 1);
    if (token.value === "let") {
      const variable = variableNameFromArg(args[0] ?? []);
      if (variable) variables.add(variable);
      return;
    }
    for (let argIndex = 0; argIndex + 2 < args.length; argIndex += 2) {
      const variable = variableNameFromArg(args[argIndex] ?? []);
      if (variable) variables.add(variable);
    }
  });
  return variables;
}

export interface FormulaEvaluationOptions {
  now?: () => Date;
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: FormulaToken[],
    private readonly resolveProp: (name: string) => FormulaValue,
    private readonly options: FormulaEvaluationOptions = {},
    private readonly variables = new Map<string, FormulaValue>(),
  ) {}

  parse(): FormulaValue {
    return this.equality();
  }

  private peek() {
    return this.tokens[this.index];
  }

  private match(type: FormulaTokenType, value?: string) {
    const token = this.peek();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) return null;
    this.index += 1;
    return token;
  }

  private equality(): FormulaValue {
    let left = this.comparison();
    while (true) {
      if (this.match("operator", "==")) left = toText(left) === toText(this.comparison());
      else if (this.match("operator", "!=")) left = toText(left) !== toText(this.comparison());
      else return left;
    }
  }

  private comparison(): FormulaValue {
    let left = this.term();
    while (true) {
      if (this.match("operator", ">")) left = toNumber(left) > toNumber(this.term());
      else if (this.match("operator", ">=")) left = toNumber(left) >= toNumber(this.term());
      else if (this.match("operator", "<")) left = toNumber(left) < toNumber(this.term());
      else if (this.match("operator", "<=")) left = toNumber(left) <= toNumber(this.term());
      else return left;
    }
  }

  private term(): FormulaValue {
    let left = this.factor();
    while (true) {
      if (this.match("operator", "+")) left = add(left, this.factor());
      else if (this.match("operator", "-")) left = toNumber(left) - toNumber(this.factor());
      else return left;
    }
  }

  private factor(): FormulaValue {
    let left = this.power();
    while (true) {
      if (this.match("operator", "*")) left = toNumber(left) * toNumber(this.power());
      else if (this.match("operator", "/")) left = toNumber(left) / toNumber(this.power());
      else if (this.match("operator", "%")) left = toNumber(left) % toNumber(this.power());
      else return left;
    }
  }

  private power(): FormulaValue {
    const left = this.unary();
    if (this.match("operator", "^")) return Math.pow(toNumber(left), toNumber(this.power()));
    return left;
  }

  private unary(): FormulaValue {
    if (this.match("operator", "-")) return -toNumber(this.unary());
    return this.primary();
  }

  private variableName(): string {
    const token = this.match("identifier") ?? this.match("string");
    return token?.value ?? "";
  }

  private bindVariable(
    name: string,
    value: FormulaValue,
    bindings: Array<[string, FormulaValue | undefined, boolean]>,
  ) {
    if (!name) return;
    bindings.push([name, this.variables.get(name), this.variables.has(name)]);
    this.variables.set(name, value);
  }

  private restoreVariables(bindings: Array<[string, FormulaValue | undefined, boolean]>) {
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const [name, value, hadValue] = bindings[index];
      if (hadValue) this.variables.set(name, value ?? null);
      else this.variables.delete(name);
    }
  }

  private looksLikeVariableBinding() {
    const first = this.peek();
    const second = this.tokens[this.index + 1];
    return !!first && (first.type === "identifier" || first.type === "string") && second?.type === "comma";
  }

  private letCall(multiple: boolean): FormulaValue {
    const bindings: Array<[string, FormulaValue | undefined, boolean]> = [];
    try {
      if (!multiple) {
        const name = this.variableName();
        this.match("comma");
        const value = this.equality();
        this.match("comma");
        this.bindVariable(name, value, bindings);
        const result = this.equality();
        this.match("paren", ")");
        return result;
      }

      while (this.looksLikeVariableBinding()) {
        const name = this.variableName();
        this.match("comma");
        const value = this.equality();
        this.bindVariable(name, value, bindings);
        if (!this.match("comma")) {
          this.match("paren", ")");
          return "";
        }
        if (!this.looksLikeVariableBinding()) {
          const result = this.equality();
          this.match("paren", ")");
          return result;
        }
      }

      const result = this.equality();
      this.match("paren", ")");
      return result;
    } finally {
      this.restoreVariables(bindings);
    }
  }

  private primary(): FormulaValue {
    const number = this.match("number");
    if (number) return Number(number.value);
    const string = this.match("string");
    if (string) return string.value;
    const identifier = this.match("identifier");
    if (identifier) {
      const name = identifier.value;
      if (this.match("paren", "(")) {
        if (name === "let") return this.letCall(false);
        if (name === "lets") return this.letCall(true);
        const args: FormulaValue[] = [];
        if (!this.match("paren", ")")) {
          do {
            args.push(this.equality());
          } while (this.match("comma"));
          this.match("paren", ")");
        }
        return this.call(name, args);
      }
      if (name === "true") return true;
      if (name === "false") return false;
      if (name === "null") return null;
      if (this.variables.has(name)) return this.variables.get(name) ?? "";
      return "";
    }
    if (this.match("paren", "(")) {
      const value = this.equality();
      this.match("paren", ")");
      return value;
    }
    return "";
  }

  private currentDate() {
    return this.options.now?.() ?? new Date();
  }

  private call(name: string, args: FormulaValue[]): FormulaValue {
    switch (name) {
      case "prop":
        return this.resolveProp(toText(args[0] ?? ""));
      case "if":
        return toBoolean(args[0] ?? null) ? (args[1] ?? "") : (args[2] ?? "");
      case "ifs": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          if (toBoolean(args[index] ?? null)) return args[index + 1] ?? "";
        }
        return args.length % 2 === 1 ? (args[args.length - 1] ?? "") : "";
      }
      case "concat":
        return args.map(toText).join("");
      case "repeat":
        return repeatValue(args[0], args[1]);
      case "format":
        return formatFormulaValue(args[0] ?? null);
      case "toNumber":
        return toNumber(args[0] ?? null);
      case "add":
        return numberValues(args).reduce((sum, value) => sum + value, 0);
      case "subtract":
        return toNumber(args[0] ?? null) - toNumber(args[1] ?? null);
      case "multiply":
        return numberValues(args).reduce((product, value) => product * value, args.length ? 1 : 0);
      case "divide":
        return toNumber(args[0] ?? null) / toNumber(args[1] ?? null);
      case "mod":
        return toNumber(args[0] ?? null) % toNumber(args[1] ?? null);
      case "pow":
        return Math.pow(toNumber(args[0] ?? null), toNumber(args[1] ?? null));
      case "min":
        return args.length ? Math.min(...numberValues(args)) : 0;
      case "max":
        return args.length ? Math.max(...numberValues(args)) : 0;
      case "sum":
        return numberValues(args).reduce((sum, value) => sum + value, 0);
      case "mean":
        return args.length ? numberValues(args).reduce((sum, value) => sum + value, 0) / args.length : 0;
      case "median":
        return medianValue(args);
      case "sqrt":
        return Math.sqrt(toNumber(args[0] ?? null));
      case "cbrt":
        return Math.cbrt(toNumber(args[0] ?? null));
      case "exp":
        return Math.exp(toNumber(args[0] ?? null));
      case "ln":
        return Math.log(toNumber(args[0] ?? null));
      case "log10":
        return Math.log10(toNumber(args[0] ?? null));
      case "log2":
        return Math.log2(toNumber(args[0] ?? null));
      case "sign":
        return Math.sign(toNumber(args[0] ?? null));
      case "pi":
        return Math.PI;
      case "e":
        return Math.E;
      case "lower":
        return toText(args[0] ?? "").toLowerCase();
      case "upper":
        return toText(args[0] ?? "").toUpperCase();
      case "trim":
        return toText(args[0] ?? "").trim();
      case "startsWith":
        return toText(args[0] ?? "").startsWith(toText(args[1] ?? ""));
      case "endsWith":
        return toText(args[0] ?? "").endsWith(toText(args[1] ?? ""));
      case "substring":
        return substringValue(args[0], args[1], args[2]);
      case "replace":
        return replaceValue(args[0], args[1], args[2]);
      case "replaceAll":
        return replaceValue(args[0], args[1], args[2], true);
      case "test":
        return testValue(args[0], args[1]);
      case "now":
        return dateTimeKeyValue(this.currentDate());
      case "today":
        return dateKeyValue(this.currentDate());
      case "dateAdd":
        return dateAddValue(args[0], args[1], args[2]);
      case "dateSubtract":
        return dateAddValue(args[0], -toNumber(args[1] ?? 0), args[2]);
      case "dateBetween":
        return dateBetweenValue(args[0], args[1], args[2]);
      case "dateRange":
        return dateRangeValue(args[0], args[1]);
      case "parseDate": {
        const date = dateValue(args[0]);
        return date ? dateTimeKeyValue(date) : "";
      }
      case "dateStart":
        return dateRangeEndpointValue(args[0], "start");
      case "dateEnd":
        return dateRangeEndpointValue(args[0], "end");
      case "timestamp":
        return timestampValue(args[0]);
      case "fromTimestamp":
        return fromTimestampValue(args[0]);
      case "formatDate":
        return formatDateValue(args[0], args[1]);
      case "year":
        return datePartValue(args[0], "year");
      case "month":
        return datePartValue(args[0], "month");
      case "day":
        return datePartValue(args[0], "day");
      case "date":
        return datePartValue(args[0], "day");
      case "week": {
        const date = dateValue(args[0]);
        return date ? isoWeekValue(date) : 0;
      }
      case "hour":
        return hourValue(args[0]);
      case "minute":
        return minuteValue(args[0]);
      case "round":
        return roundValue(args[0], args[1]);
      case "floor":
        return Math.floor(toNumber(args[0] ?? null));
      case "ceil":
        return Math.ceil(toNumber(args[0] ?? null));
      case "abs":
        return Math.abs(toNumber(args[0] ?? null));
      case "empty":
        return args[0] == null || args[0] === "" || args[0] === 0;
      case "contains":
        return toText(args[0] ?? "").toLowerCase().includes(toText(args[1] ?? "").toLowerCase());
      case "length":
        return toText(args[0] ?? "").length;
      case "not":
        return !toBoolean(args[0] ?? null);
      case "and":
        return args.every(toBoolean);
      case "or":
        return args.some(toBoolean);
      default:
        return "";
    }
  }
}

export function evaluateFormulaExpression(
  expression: string,
  resolveProp: (name: string) => FormulaValue,
  options: FormulaEvaluationOptions = {},
): FormulaValue {
  const trimmed = expression.trim();
  if (!trimmed) return "";
  try {
    return new Parser(tokenizeFormula(trimmed), resolveProp, options).parse();
  } catch {
    return "";
  }
}

export function formatFormulaValue(value: FormulaValue) {
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
  }
  return value;
}
