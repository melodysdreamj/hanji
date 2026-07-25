/** Pure Notion-compatible formula parser used by the Hanji MCP adapter. */
export function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function tokenizeFormula(input) {
  const tokens = [];
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
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(input[i + 1] ?? ""))) {
      let value = ch;
      let seenDot = ch === ".";
      i += 1;
      while (i < input.length && (/[0-9]/.test(input[i]) || (input[i] === "." && !seenDot))) {
        if (input[i] === ".") seenDot = true;
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
    if (ch === "[" || ch === "]") {
      tokens.push({ type: "bracket", value: ch });
      i += 1;
      continue;
    }
    if (ch === ".") {
      tokens.push({ type: "dot", value: ch });
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

const MAX_FORMULA_LIST_ITEMS = 1_000;
const MAX_FORMULA_LIST_DEPTH = 10;
const MAX_FORMULA_VALUE_TEXT = 100 * 1024;

function isFormulaReference(value) {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value.kind === "page" || value.kind === "person")
    && typeof value.id === "string"
    && typeof value.name === "string";
}

function formulaReferenceText(value) {
  return value.name || value.id;
}

function formulaToNumber(value) {
  const n = Number(formulaToText(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

function formulaToText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map((item) => formulaToText(item)).join(",");
  if (isFormulaReference(value)) return formulaReferenceText(value);
  return String(value);
}

function formulaToBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isFormulaReference(value)) return true;
  return value !== null && value !== undefined && value !== "";
}

function formulaValueBudget(value) {
  let itemCount = 0;
  let textCount = 0;

  const visit = (current, depth) => {
    if (depth > MAX_FORMULA_LIST_DEPTH) {
      throw new Error(`Formula lists may be nested at most ${MAX_FORMULA_LIST_DEPTH} levels`);
    }
    if (Array.isArray(current)) {
      itemCount += current.length;
      if (itemCount > MAX_FORMULA_LIST_ITEMS) {
        throw new Error(`Formula lists may contain at most ${MAX_FORMULA_LIST_ITEMS} items`);
      }
      for (const item of current) visit(item, depth + 1);
      return;
    }
    if (typeof current === "string") textCount += current.length;
    else if (isFormulaReference(current)) textCount += current.id.length + current.name.length;
    if (textCount > MAX_FORMULA_VALUE_TEXT) {
      throw new Error(`Formula values may contain at most ${MAX_FORMULA_VALUE_TEXT} text characters`);
    }
  };

  visit(value, 0);
  return value;
}

function listValue(values) {
  return formulaValueBudget(values);
}

function requireList(value, functionName) {
  if (!Array.isArray(value)) throw new Error(`${functionName} requires a list`);
  return value;
}

function sameFormulaValue(left, right) {
  if (isFormulaReference(left) && isFormulaReference(right)) {
    return left.kind === right.kind && left.id === right.id;
  }
  return formulaToText(left) === formulaToText(right);
}

function formulaNumbers(values) {
  return values.map((value) => formulaToNumber(value));
}

function strictListNumbers(value) {
  const values = requireList(value, "Numeric list functions");
  if (values.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    throw new Error("Numeric list functions require only numbers");
  }
  return values;
}

function reducerNumbers(values) {
  return values.length === 1 && Array.isArray(values[0])
    ? strictListNumbers(values[0])
    : formulaNumbers(values);
}

function formulaMedian(values) {
  const numbers = reducerNumbers(values).slice().sort((a, b) => a - b);
  if (!numbers.length) return 0;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function formulaRound(value, precisionValue) {
  const precision = Math.trunc(formulaToNumber(precisionValue ?? 0));
  const factor = Math.pow(10, precision);
  if (!Number.isFinite(factor) || factor === 0) return Math.round(formulaToNumber(value ?? null));
  return Math.round(formulaToNumber(value ?? null) * factor) / factor;
}

function formulaIndex(value) {
  return Math.max(0, Math.trunc(formulaToNumber(value ?? 0)));
}

function formulaSubstring(value, start, end) {
  const text = formulaToText(value ?? "");
  const from = formulaIndex(start);
  if (end === undefined || end === null || end === "") return text.slice(from);
  return text.slice(from, Math.max(from, formulaIndex(end)));
}

function formulaRepeat(value, countValue) {
  const count = Math.max(0, Math.min(1000, Math.trunc(formulaToNumber(countValue ?? 0))));
  return formulaToText(value ?? "").repeat(count).slice(0, 10000);
}

// Workspace-authored formula patterns are compiled into RegExp and run per row
// per query. Cap pattern/subject sizes and treat oversized or invalid patterns
// as literal text so a hostile pattern cannot pin the event loop with
// catastrophic backtracking on big inputs. (True ReDoS-proofing needs an
// RE2-class engine and is out of scope for this cheap mitigation.)
const FORMULA_REGEX_MAX_PATTERN_LENGTH = 256;
const FORMULA_REGEX_MAX_SUBJECT_LENGTH = 10_000;

function formulaRegExp(pattern, flags, subjectLength) {
  if (pattern.length > FORMULA_REGEX_MAX_PATTERN_LENGTH) return null;
  if (subjectLength > FORMULA_REGEX_MAX_SUBJECT_LENGTH) return null;
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export function formulaReplace(value, patternValue, replacementValue, all = false) {
  const text = formulaToText(value ?? "");
  const pattern = formulaToText(patternValue ?? "");
  const replacement = formulaToText(replacementValue ?? "");
  if (!pattern) return text;
  const regex = formulaRegExp(pattern, all ? "g" : "", text.length);
  if (regex) return text.replace(regex, replacement);
  return all ? text.split(pattern).join(replacement) : text.replace(pattern, replacement);
}

export function formulaTest(value, patternValue) {
  const pattern = formulaToText(patternValue ?? "");
  if (!pattern) return false;
  const text = formulaToText(value ?? "");
  const regex = formulaRegExp(pattern, "", text.length);
  return regex ? regex.test(text) : text.includes(pattern);
}

export function formulaDate(value) {
  const raw = formulaToText(value ?? "").split("/")[0].trim();
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(raw);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(Date.UTC(
      year,
      month,
      day,
      Number(match[4] ?? 0),
      Number(match[5] ?? 0),
      Number(match[6] ?? 0),
    ));
    if (Number.isNaN(date.getTime())) return null;
    // Reject calendar overflow (e.g. 2024-02-30 → 2024-03-01): Date.UTC rolls
    // invalid day/month values forward, but the shared formula core treats them
    // as invalid, so round-trip the components and bail if they shifted.
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return date;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formulaDateEnd(value) {
  const text = formulaToText(value ?? "");
  const end = text.split("/")[1]?.trim();
  return formulaDate(end || text);
}

export function formulaDateKeyFromDate(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formulaDateTimeKeyFromDate(date) {
  const dateKey = formulaDateKeyFromDate(date);
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${dateKey}T${hour}:${minute}:${second}Z`;
}

function formulaDateRange(startValue, endValue) {
  const start = formulaDate(startValue);
  const end = formulaDate(endValue);
  if (!start || !end) return "";
  return `${formulaDateTimeKeyFromDate(start)}/${formulaDateTimeKeyFromDate(end)}`;
}

function formulaIsoWeek(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

function formulaDateUnit(value) {
  const unit = formulaToText(value ?? "days").trim().toLowerCase();
  if (unit === "year" || unit === "years") return "years";
  if (unit === "quarter" || unit === "quarters") return "quarters";
  if (unit === "month" || unit === "months") return "months";
  if (unit === "week" || unit === "weeks") return "weeks";
  if (unit === "hour" || unit === "hours") return "hours";
  if (unit === "minute" || unit === "minutes") return "minutes";
  return "days";
}

function addMonthsUtc(date, months) {
  const out = new Date(date.getTime());
  const day = out.getUTCDate();
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function formulaDateAdd(value, amountValue, unitValue) {
  const date = formulaDate(value);
  if (!date) return "";
  const amount = Math.trunc(formulaToNumber(amountValue ?? 0));
  const unit = formulaDateUnit(unitValue);
  let out = new Date(date.getTime());
  if (unit === "years") out = addMonthsUtc(out, amount * 12);
  else if (unit === "quarters") out = addMonthsUtc(out, amount * 3);
  else if (unit === "months") out = addMonthsUtc(out, amount);
  else if (unit === "weeks") out.setUTCDate(out.getUTCDate() + amount * 7);
  else if (unit === "hours") out.setUTCHours(out.getUTCHours() + amount);
  else if (unit === "minutes") out.setUTCMinutes(out.getUTCMinutes() + amount);
  else out.setUTCDate(out.getUTCDate() + amount);
  return formulaDateKeyFromDate(out);
}

function formulaDateBetween(endValue, startValue, unitValue) {
  const end = formulaDate(endValue);
  const start = formulaDate(startValue);
  if (!end || !start) return 0;
  const unit = formulaDateUnit(unitValue);
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

function formulaDatePart(value, part) {
  const date = formulaDate(value);
  if (!date) return 0;
  if (part === "year") return date.getUTCFullYear();
  if (part === "month") return date.getUTCMonth() + 1;
  return date.getUTCDate();
}

function formulaHour(value) {
  const date = formulaDate(value);
  return date ? date.getUTCHours() : 0;
}

function formulaMinute(value) {
  const date = formulaDate(value);
  return date ? date.getUTCMinutes() : 0;
}

function formulaTimestamp(value) {
  const date = formulaDate(value);
  return date ? date.getTime() : 0;
}

function formulaFromTimestamp(value) {
  const date = new Date(formulaToNumber(value ?? null));
  return Number.isNaN(date.getTime()) ? "" : formulaDateTimeKeyFromDate(date);
}

function formulaDateRangeEndpoint(value, endpoint) {
  const date = endpoint === "end" ? formulaDateEnd(value) : formulaDate(value);
  return date ? formulaDateKeyFromDate(date) : "";
}

function formulaFormatDate(value, formatValue) {
  const date = formulaDate(value);
  if (!date) return "";
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const tokens = {
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
  const format = formulaToText(formatValue ?? "YYYY-MM-DD") || "YYYY-MM-DD";
  return format.replace(/YYYY|MMM|HH|MM|DD|mm|Y|M|D|h/g, (token) => tokens[token] ?? token);
}

export function formatFormulaValue(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map((item) => formatFormulaValue(item)).join(", ");
  if (isFormulaReference(value)) return formulaReferenceText(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return compactNumber(value);
  return String(value);
}

class FormulaParser {
  constructor(tokens, resolveProp, variables = new Map()) {
    this.tokens = tokens;
    this.resolveProp = resolveProp;
    this.variables = variables;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }

  match(type, value) {
    const token = this.peek();
    if (!token || token.type !== type || (value !== undefined && token.value !== value)) return null;
    this.index += 1;
    return token;
  }

  parse() {
    const value = this.equality();
    if (this.index < this.tokens.length) throw new Error("Unexpected formula token");
    return formulaValueBudget(value);
  }

  equality() {
    let left = this.comparison();
    while (true) {
      if (this.match("operator", "==")) left = sameFormulaValue(left, this.comparison());
      else if (this.match("operator", "!=")) left = !sameFormulaValue(left, this.comparison());
      else return left;
    }
  }

  comparison() {
    let left = this.term();
    while (true) {
      if (this.match("operator", ">")) left = formulaToNumber(left) > formulaToNumber(this.term());
      else if (this.match("operator", ">=")) left = formulaToNumber(left) >= formulaToNumber(this.term());
      else if (this.match("operator", "<")) left = formulaToNumber(left) < formulaToNumber(this.term());
      else if (this.match("operator", "<=")) left = formulaToNumber(left) <= formulaToNumber(this.term());
      else return left;
    }
  }

  term() {
    let left = this.factor();
    while (true) {
      if (this.match("operator", "+")) {
        const right = this.factor();
        left =
          typeof left === "string"
          || typeof right === "string"
          || Array.isArray(left)
          || Array.isArray(right)
          || isFormulaReference(left)
          || isFormulaReference(right)
            ? `${formulaToText(left)}${formulaToText(right)}`
            : formulaToNumber(left) + formulaToNumber(right);
      } else if (this.match("operator", "-")) {
        left = formulaToNumber(left) - formulaToNumber(this.factor());
      } else return left;
    }
  }

  factor() {
    let left = this.power();
    while (true) {
      if (this.match("operator", "*")) left = formulaToNumber(left) * formulaToNumber(this.power());
      else if (this.match("operator", "/")) left = formulaToNumber(left) / formulaToNumber(this.power());
      else if (this.match("operator", "%")) left = formulaToNumber(left) % formulaToNumber(this.power());
      else return left;
    }
  }

  power() {
    const left = this.unary();
    if (this.match("operator", "^")) return Math.pow(formulaToNumber(left), formulaToNumber(this.power()));
    return left;
  }

  unary() {
    if (this.match("operator", "-")) return -formulaToNumber(this.unary());
    return this.primary();
  }

  primary() {
    let value;
    const number = this.match("number");
    if (number) value = Number(number.value);
    else {
      const string = this.match("string");
      if (string) value = string.value;
      else if (this.match("bracket", "[")) {
        const items = [];
        if (!this.match("bracket", "]")) {
          do {
            items.push(this.equality());
          } while (this.match("comma"));
          if (!this.match("bracket", "]")) throw new Error("Formula list is not closed");
        }
        value = listValue(items);
      } else {
        const identifier = this.match("identifier");
        if (identifier) value = this.identifierValue(identifier.value);
        else if (this.match("paren", "(")) {
          value = this.equality();
          if (!this.match("paren", ")")) throw new Error("Formula parentheses are not balanced");
        } else {
          value = "";
        }
      }
    }
    return this.postfix(formulaValueBudget(value));
  }

  identifierValue(name) {
    if (this.match("paren", "(")) return this.callTokens(name, this.takeCallArguments());
    if (name === "true") return true;
    if (name === "false") return false;
    if (name === "null") return null;
    if (this.variables.has(name)) return this.variables.get(name) ?? "";
    return "";
  }

  postfix(initial) {
    let value = initial;
    while (this.match("dot", ".")) {
      const method = this.match("identifier");
      if (!method) throw new Error("Formula method name is missing");
      const args = this.match("paren", "(") ? this.takeCallArguments() : [];
      value = formulaValueBudget(this.callTokens(method.value, args, value));
    }
    return value;
  }

  takeCallArguments() {
    const args = [];
    let current = [];
    let parenDepth = 0;
    let bracketDepth = 0;
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index];
      this.index += 1;
      if (token.type === "paren" && token.value === "(") {
        parenDepth += 1;
        current.push(token);
        continue;
      }
      if (token.type === "paren" && token.value === ")") {
        if (parenDepth === 0 && bracketDepth === 0) {
          if (current.length > 0 || args.length > 0) args.push(current);
          return args;
        }
        parenDepth -= 1;
        current.push(token);
        continue;
      }
      if (token.type === "bracket" && token.value === "[") bracketDepth += 1;
      if (token.type === "bracket" && token.value === "]") bracketDepth -= 1;
      if (token.type === "comma" && parenDepth === 0 && bracketDepth === 0) {
        args.push(current);
        current = [];
        continue;
      }
      current.push(token);
    }
    throw new Error("Formula parentheses are not balanced");
  }

  evaluateTokens(tokens, variables = this.variables) {
    return new FormulaParser(tokens, this.resolveProp, new Map(variables)).parse();
  }

  tokenVariableName(tokens) {
    if (tokens.length !== 1) return "";
    const token = tokens[0];
    if (token.type !== "identifier" && token.type !== "string") return "";
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value) ? token.value : "";
  }

  letTokens(args, multiple) {
    const variables = new Map(this.variables);
    if (!multiple) {
      if (args.length < 3) return "";
      const name = this.tokenVariableName(args[0]);
      if (!name) return "";
      variables.set(name, this.evaluateTokens(args[1], variables));
      return this.evaluateTokens(args[2], variables);
    }
    if (args.length < 3 || args.length % 2 === 0) return "";
    for (let index = 0; index + 1 < args.length - 1; index += 2) {
      const name = this.tokenVariableName(args[index]);
      if (!name) return "";
      variables.set(name, this.evaluateTokens(args[index + 1], variables));
    }
    return this.evaluateTokens(args[args.length - 1], variables);
  }

  higherOrder(name, value, expression) {
    const items = requireList(value, name);
    const evaluate = (item, index) => {
      const variables = new Map(this.variables);
      variables.set("current", item);
      variables.set("index", index);
      return this.evaluateTokens(expression, variables);
    };
    if (name === "map") return listValue(items.map(evaluate));
    if (name === "filter") return listValue(items.filter((item, index) => formulaToBoolean(evaluate(item, index))));
    if (name === "find") {
      const index = items.findIndex((item, itemIndex) => formulaToBoolean(evaluate(item, itemIndex)));
      return index < 0 ? "" : items[index];
    }
    if (name === "findIndex") return items.findIndex((item, index) => formulaToBoolean(evaluate(item, index)));
    if (name === "some") return items.some((item, index) => formulaToBoolean(evaluate(item, index)));
    return items.every((item, index) => formulaToBoolean(evaluate(item, index)));
  }

  callTokens(name, args, receiver) {
    if (receiver !== undefined && name === "prop") {
      throw new Error("prop() cannot be called as a method");
    }
    if (receiver === undefined && name === "let") return this.letTokens(args, false);
    if (receiver === undefined && name === "lets") return this.letTokens(args, true);
    if (["map", "filter", "find", "findIndex", "some", "every"].includes(name)) {
      const value = receiver ?? this.evaluateTokens(args[0] ?? []);
      const expression = args[receiver === undefined ? 1 : 0] ?? [];
      return this.higherOrder(name, value, expression);
    }
    const values = args.map((tokens) => this.evaluateTokens(tokens));
    return this.call(name, receiver === undefined ? values : [receiver, ...values]);
  }

  call(name, args) {
    switch (name) {
      case "prop":
        return this.resolveProp(formulaToText(args[0]));
      case "if":
        return formulaToBoolean(args[0]) ? (args[1] ?? "") : (args[2] ?? "");
      case "ifs": {
        for (let index = 0; index + 1 < args.length; index += 2) {
          if (formulaToBoolean(args[index] ?? null)) return args[index + 1] ?? "";
        }
        return args.length % 2 === 1 ? (args[args.length - 1] ?? "") : "";
      }
      case "concat": {
        if (args.some(Array.isArray)) {
          const values = args.flatMap((value) => (Array.isArray(value) ? value : [value]));
          return listValue(values);
        }
        return args.map(formulaToText).join("");
      }
      case "repeat":
        return formulaRepeat(args[0], args[1]);
      case "format":
        return formatFormulaValue(args[0]);
      case "toNumber":
        return formulaToNumber(args[0]);
      case "add":
        return formulaNumbers(args).reduce((sum, value) => sum + value, 0);
      case "subtract":
        return formulaToNumber(args[0] ?? null) - formulaToNumber(args[1] ?? null);
      case "multiply":
        return formulaNumbers(args).reduce((product, value) => product * value, args.length ? 1 : 0);
      case "divide":
        return formulaToNumber(args[0] ?? null) / formulaToNumber(args[1] ?? null);
      case "mod":
        return formulaToNumber(args[0] ?? null) % formulaToNumber(args[1] ?? null);
      case "pow":
        return Math.pow(formulaToNumber(args[0] ?? null), formulaToNumber(args[1] ?? null));
      case "min": {
        const values = reducerNumbers(args);
        return values.length ? Math.min(...values) : 0;
      }
      case "max": {
        const values = reducerNumbers(args);
        return values.length ? Math.max(...values) : 0;
      }
      case "sum":
        return reducerNumbers(args).reduce((sum, value) => sum + value, 0);
      case "mean": {
        const values = reducerNumbers(args);
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
      }
      case "median":
        return formulaMedian(args);
      case "sqrt":
        return Math.sqrt(formulaToNumber(args[0] ?? null));
      case "cbrt":
        return Math.cbrt(formulaToNumber(args[0] ?? null));
      case "exp":
        return Math.exp(formulaToNumber(args[0] ?? null));
      case "ln":
        return Math.log(formulaToNumber(args[0] ?? null));
      case "log10":
        return Math.log10(formulaToNumber(args[0] ?? null));
      case "log2":
        return Math.log2(formulaToNumber(args[0] ?? null));
      case "sign":
        return Math.sign(formulaToNumber(args[0] ?? null));
      case "pi":
        return Math.PI;
      case "e":
        return Math.E;
      case "lower":
        return formulaToText(args[0] ?? "").toLowerCase();
      case "upper":
        return formulaToText(args[0] ?? "").toUpperCase();
      case "trim":
        return formulaToText(args[0] ?? "").trim();
      case "startsWith":
        return formulaToText(args[0] ?? "").startsWith(formulaToText(args[1] ?? ""));
      case "endsWith":
        return formulaToText(args[0] ?? "").endsWith(formulaToText(args[1] ?? ""));
      case "substring":
        return formulaSubstring(args[0], args[1], args[2]);
      case "replace":
        return formulaReplace(args[0], args[1], args[2]);
      case "replaceAll":
        return formulaReplace(args[0], args[1], args[2], true);
      case "test":
        return formulaTest(args[0], args[1]);
      case "now":
        return formulaDateTimeKeyFromDate(new Date());
      case "today":
        return formulaDateKeyFromDate(new Date());
      case "dateAdd":
        return formulaDateAdd(args[0], args[1], args[2]);
      case "dateSubtract":
        return formulaDateAdd(args[0], -formulaToNumber(args[1] ?? 0), args[2]);
      case "dateBetween":
        return formulaDateBetween(args[0], args[1], args[2]);
      case "dateRange":
        return formulaDateRange(args[0], args[1]);
      case "parseDate": {
        const date = formulaDate(args[0]);
        return date ? formulaDateTimeKeyFromDate(date) : "";
      }
      case "dateStart":
        return formulaDateRangeEndpoint(args[0], "start");
      case "dateEnd":
        return formulaDateRangeEndpoint(args[0], "end");
      case "timestamp":
        return formulaTimestamp(args[0]);
      case "fromTimestamp":
        return formulaFromTimestamp(args[0]);
      case "formatDate":
        return formulaFormatDate(args[0], args[1]);
      case "year":
        return formulaDatePart(args[0], "year");
      case "month":
        return formulaDatePart(args[0], "month");
      case "day":
        return formulaDatePart(args[0], "day");
      case "date":
        return formulaDatePart(args[0], "day");
      case "week": {
        const date = formulaDate(args[0]);
        return date ? formulaIsoWeek(date) : 0;
      }
      case "hour":
        return formulaHour(args[0]);
      case "minute":
        return formulaMinute(args[0]);
      case "round":
        return formulaRound(args[0], args[1]);
      case "floor":
        return Math.floor(formulaToNumber(args[0]));
      case "ceil":
        return Math.ceil(formulaToNumber(args[0]));
      case "abs":
        return Math.abs(formulaToNumber(args[0]));
      case "empty":
        return Array.isArray(args[0])
          ? args[0].length === 0
          : args[0] == null || args[0] === "" || args[0] === 0;
      case "contains":
        return formulaToText(args[0]).toLowerCase().includes(formulaToText(args[1]).toLowerCase());
      case "length":
        return Array.isArray(args[0]) ? args[0].length : formulaToText(args[0]).length;
      case "not":
        return !formulaToBoolean(args[0]);
      case "and":
        return args.every(formulaToBoolean);
      case "or":
        return args.some(formulaToBoolean);
      case "at": {
        const values = requireList(args[0], "at");
        const index = Math.trunc(formulaToNumber(args[1] ?? 0));
        return index >= 0 && index < values.length ? values[index] : "";
      }
      case "first": {
        const values = requireList(args[0], "first");
        return values.length ? values[0] : "";
      }
      case "last": {
        const values = requireList(args[0], "last");
        return values.length ? values[values.length - 1] : "";
      }
      case "slice": {
        const values = requireList(args[0], "slice");
        const start = Math.trunc(formulaToNumber(args[1] ?? 0));
        const end = args[2] === undefined ? undefined : Math.trunc(formulaToNumber(args[2]));
        return listValue(values.slice(start, end));
      }
      case "sort": {
        const values = requireList(args[0], "sort").slice();
        values.sort((left, right) => {
          if (typeof left === "number" && typeof right === "number") return left - right;
          const a = formulaToText(left);
          const b = formulaToText(right);
          return a < b ? -1 : a > b ? 1 : 0;
        });
        return listValue(values);
      }
      case "reverse":
        return listValue(requireList(args[0], "reverse").slice().reverse());
      case "join":
        return requireList(args[0], "join").map((value) => formulaToText(value)).join(formulaToText(args[1] ?? ""));
      case "split":
        return listValue(formulaToText(args[0] ?? "").split(formulaToText(args[1] ?? "")));
      case "unique": {
        const values = [];
        for (const value of requireList(args[0], "unique")) {
          if (!values.some((candidate) => sameFormulaValue(candidate, value))) values.push(value);
        }
        return listValue(values);
      }
      case "includes":
        return requireList(args[0], "includes").some((value) => sameFormulaValue(value, args[1] ?? null));
      case "flat":
        return listValue(requireList(args[0], "flat").flatMap((value) => (Array.isArray(value) ? value : [value])));
      case "name":
        return isFormulaReference(args[0]) ? formulaReferenceText(args[0]) : formulaToText(args[0] ?? "");
      case "id":
        return isFormulaReference(args[0]) ? args[0].id : "";
      default:
        return "";
    }
  }
}

export function evaluateFormulaExpression(expression, resolveProperty) {
  const trimmed = expression.trim();
  if (!trimmed) return "";
  try {
    return new FormulaParser(tokenizeFormula(trimmed), resolveProperty).parse();
  } catch {
    return "";
  }
}
