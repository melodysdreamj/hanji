import { compareNaturalText } from "./database/natural-order.mjs";

export const NOTION_MCP_SQL_LIMITS = Object.freeze({
  maxSqlBytes: 32 * 1024,
  maxParams: 256,
  maxDepth: 16,
  maxNodes: 512,
  maxOutputRows: 500,
  maxSources: 10,
  maxSelectParts: 10,
  maxSelectStatements: 32,
  maxCtes: 8,
  maxJoins: 8,
  maxSubqueries: 16,
  maxIntermediateRows: 10_000,
  maxJoinRows: 10_000,
  maxWorkUnits: 100_000,
});

const AGGREGATE_FUNCTIONS = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX"]);
const SCALAR_FUNCTIONS = new Set(["ABS", "COALESCE", "IFNULL", "LENGTH", "LOWER", "NULLIF", "ROUND", "UPPER"]);
const SOURCE_PATTERN = /^collection:\/\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const CLAUSE_ERROR =
  "Only bounded read-only SELECT statements with FROM, WHERE/GROUP BY/HAVING/ORDER BY/LIMIT/OFFSET, JOIN, CTE, and subquery clauses are supported.";
const ALIAS_STOP_WORDS = new Set([
  "ASC", "CROSS", "DESC", "ELSE", "END", "FROM", "FULL", "GROUP", "HAVING", "INNER", "JOIN",
  "LEFT", "LIMIT", "NATURAL", "OFFSET", "ON", "ORDER", "OUTER", "RIGHT", "THEN", "UNION", "WHEN", "WHERE",
]);

function sqlByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function token(type, value, raw, position) {
  return { type, value, raw, position };
}

function tokenizeSql(value) {
  const input = String(value ?? "");
  const tokens = [];
  for (let index = 0; index < input.length;) {
    const character = input[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      const quote = character;
      const type = quote === '"' ? "identifier" : "string";
      const start = index;
      let decoded = "";
      index += 1;
      let closed = false;
      while (index < input.length) {
        const current = input[index];
        if (current === quote) {
          if (input[index + 1] === quote) {
            decoded += quote;
            index += 2;
            continue;
          }
          index += 1;
          closed = true;
          break;
        }
        if (current === "\\" && input[index + 1] === quote) {
          decoded += quote;
          index += 2;
          continue;
        }
        decoded += current;
        index += 1;
      }
      if (!closed) throw new Error(`Unterminated SQL ${type} at byte ${start}.`);
      tokens.push(token(type, decoded, input.slice(start, index), start));
      continue;
    }
    const two = input.slice(index, index + 2);
    if (["!=", "<>", ">=", "<=", "||"].includes(two)) {
      tokens.push(token("operator", two, two, index));
      index += 2;
      continue;
    }
    if (["=", ">", "<", "+", "-", "/", "%"].includes(character)) {
      tokens.push(token("operator", character, character, index));
      index += 1;
      continue;
    }
    if (character === "?") {
      tokens.push(token("param", "?", "?", index));
      index += 1;
      continue;
    }
    if (["(", ")", ",", ".", "*"].includes(character)) {
      tokens.push(token("punct", character, character, index));
      index += 1;
      continue;
    }
    const numeric = input.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (numeric) {
      tokens.push(token("number", Number(numeric[0]), numeric[0], index));
      index += numeric[0].length;
      continue;
    }
    const word = input.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/);
    if (word) {
      tokens.push(token("word", word[0], word[0], index));
      index += word[0].length;
      continue;
    }
    throw new Error(`Unsupported SQL token ${JSON.stringify(character)} at byte ${index}.`);
  }
  if (tokens.length > 4096) throw new Error("SQL contains too many tokens.");
  return tokens;
}

function isWord(item, value) {
  return item?.type === "word" && String(item.value).toUpperCase() === value;
}

function isPunct(item, value) {
  return item?.type === "punct" && item.value === value;
}

function identifierValue(item, label = "SQL identifier") {
  if (item?.type === "identifier" || item?.type === "word") return String(item.value);
  throw new Error(`${label} must be a quoted or bare identifier.`);
}

function stableValueKey(value) {
  return JSON.stringify(value, (_key, current) => current === undefined ? null : current);
}

function expressionKey(expression) {
  return stableValueKey(expression);
}

function walkExpression(expression, visitor, insideAggregate = false) {
  if (!expression || typeof expression !== "object") return;
  visitor(expression, insideAggregate);
  if (expression.type === "subquery" || expression.type === "exists") return;
  if (expression.type === "call") {
    const aggregate = expression.aggregate === true;
    for (const argument of expression.arguments) walkExpression(argument, visitor, insideAggregate || aggregate);
    return;
  }
  for (const [key, value] of Object.entries(expression)) {
    if (["query", "arguments", "type"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) walkExpression(item, visitor, insideAggregate);
    } else if (value && typeof value === "object") {
      walkExpression(value, visitor, insideAggregate);
    }
  }
}

function containsAggregate(expression) {
  let found = false;
  walkExpression(expression, (node) => {
    if (node.type === "call" && node.aggregate) found = true;
  });
  return found;
}

function containsColumnOutsideAggregate(expression) {
  let found = false;
  walkExpression(expression, (node, insideAggregate) => {
    if (node.type === "column" && !insideAggregate) found = true;
  });
  return found;
}

class SqlParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
    this.parameterCount = 0;
    this.nodeCount = 0;
    this.selectCount = 0;
    this.cteCount = 0;
    this.joinCount = 0;
    this.subqueryCount = 0;
    this.sourceUrls = [];
    this.sourceUrlSet = new Set();
    this.activeScope = new Map();
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset];
  }

  checkDepth(depth) {
    if (depth > NOTION_MCP_SQL_LIMITS.maxDepth) {
      throw new Error(`SQL expression depth exceeds ${NOTION_MCP_SQL_LIMITS.maxDepth}.`);
    }
  }

  node(value) {
    this.nodeCount += 1;
    if (this.nodeCount > NOTION_MCP_SQL_LIMITS.maxNodes) {
      throw new Error(`SQL AST exceeds ${NOTION_MCP_SQL_LIMITS.maxNodes} nodes.`);
    }
    return value;
  }

  consumeWord(value) {
    if (!isWord(this.peek(), value)) return false;
    this.index += 1;
    return true;
  }

  expectWord(value, message) {
    if (!this.consumeWord(value)) throw new Error(message ?? `SQL requires ${value}.`);
  }

  consumePunct(value) {
    if (!isPunct(this.peek(), value)) return false;
    this.index += 1;
    return true;
  }

  expectPunct(value, message) {
    if (!this.consumePunct(value)) throw new Error(message ?? `SQL requires ${value}.`);
  }

  parseIdentifier(label) {
    const value = identifierValue(this.peek(), label);
    this.index += 1;
    return value;
  }

  addSource(url) {
    if (this.sourceUrlSet.has(url)) return;
    this.sourceUrlSet.add(url);
    this.sourceUrls.push(url);
    if (this.sourceUrls.length > NOTION_MCP_SQL_LIMITS.maxSources) {
      throw new Error(`SQL may reference at most ${NOTION_MCP_SQL_LIMITS.maxSources} data sources.`);
    }
  }

  parseQuery(scope = new Map(), depth = 0) {
    this.checkDepth(depth);
    const ctes = [];
    const queryScope = new Map(scope);
    if (this.consumeWord("WITH")) {
      if (this.consumeWord("RECURSIVE")) throw new Error("Recursive CTEs are not supported.");
      do {
        this.cteCount += 1;
        if (this.cteCount > NOTION_MCP_SQL_LIMITS.maxCtes) {
          throw new Error(`SQL may contain at most ${NOTION_MCP_SQL_LIMITS.maxCtes} CTEs.`);
        }
        const name = this.parseIdentifier("CTE name");
        const key = name.toLowerCase();
        if (queryScope.has(key)) throw new Error(`Duplicate SQL CTE name: ${name}.`);
        const columns = [];
        if (this.consumePunct("(")) {
          do columns.push(this.parseIdentifier("CTE output column"));
          while (this.consumePunct(","));
          this.expectPunct(")", "CTE output columns must close with ).");
          if (new Set(columns).size !== columns.length) throw new Error(`CTE ${name} has duplicate output columns.`);
        }
        this.expectWord("AS", "CTE declarations require AS.");
        this.expectPunct("(", "CTE queries must be parenthesized.");
        const cteQuery = this.parseQuery(queryScope, depth + 1);
        this.expectPunct(")", "CTE query is missing a closing parenthesis.");
        const cte = this.node({ type: "cte", name, key, columns, query: cteQuery });
        ctes.push(cte);
        queryScope.set(key, cte);
      } while (this.consumePunct(","));
    }
    const compound = this.parseCompound(queryScope, depth);
    return this.node({ type: "query", ctes, compound });
  }

  parseCompound(scope, depth) {
    const parts = [this.parseSelect(scope, depth)];
    const operators = [];
    while (this.consumeWord("UNION")) {
      const operator = this.consumeWord("ALL") ? "all" : "distinct";
      operators.push(operator);
      parts.push(this.parseSelect(scope, depth));
      if (parts.length > NOTION_MCP_SQL_LIMITS.maxSelectParts) {
        throw new Error(`SQL may contain at most ${NOTION_MCP_SQL_LIMITS.maxSelectParts} SELECT parts.`);
      }
    }
    return this.node({ type: "compound", parts, operators });
  }

  parseSelect(scope, depth) {
    this.checkDepth(depth);
    this.expectWord("SELECT", CLAUSE_ERROR);
    this.selectCount += 1;
    if (this.selectCount > NOTION_MCP_SQL_LIMITS.maxSelectStatements) {
      throw new Error(`SQL may contain at most ${NOTION_MCP_SQL_LIMITS.maxSelectStatements} SELECT statements.`);
    }
    const previousScope = this.activeScope;
    this.activeScope = scope;
    const parameterStart = this.parameterCount;
    const start = this.index - 1;
    const distinct = this.consumeWord("DISTINCT");
    const selectItems = [];
    do selectItems.push(this.parseSelectItem(depth));
    while (this.consumePunct(","));
    if (!selectItems.length) throw new Error("SELECT requires at least one expression.");
    this.expectWord("FROM", CLAUSE_ERROR);
    const from = this.parseSource(scope);
    const aliases = new Set([from.aliasKey]);
    const joins = [];
    while (true) {
      let joinType;
      if (this.consumeWord("JOIN")) joinType = "inner";
      else if (this.consumeWord("INNER")) {
        this.expectWord("JOIN", "INNER must be followed by JOIN.");
        joinType = "inner";
      } else if (this.consumeWord("LEFT")) {
        this.consumeWord("OUTER");
        this.expectWord("JOIN", "LEFT must be followed by JOIN.");
        joinType = "left";
      } else if (this.consumeWord("RIGHT")) {
        this.consumeWord("OUTER");
        this.expectWord("JOIN", "RIGHT must be followed by JOIN.");
        joinType = "right";
      } else if (this.consumeWord("FULL")) {
        this.consumeWord("OUTER");
        this.expectWord("JOIN", "FULL must be followed by JOIN.");
        joinType = "full";
      } else if (this.consumeWord("CROSS")) {
        this.expectWord("JOIN", "CROSS must be followed by JOIN.");
        joinType = "cross";
      } else if (isWord(this.peek(), "NATURAL")) {
        throw new Error("NATURAL JOIN is not supported; use an explicit ON expression.");
      } else {
        break;
      }
      this.joinCount += 1;
      if (this.joinCount > NOTION_MCP_SQL_LIMITS.maxJoins) {
        throw new Error(`SQL may contain at most ${NOTION_MCP_SQL_LIMITS.maxJoins} joins.`);
      }
      const source = this.parseSource(scope);
      if (aliases.has(source.aliasKey)) throw new Error(`Duplicate SQL source alias: ${source.alias}.`);
      aliases.add(source.aliasKey);
      let on;
      if (joinType === "cross") {
        if (this.consumeWord("ON")) throw new Error("CROSS JOIN does not accept ON.");
      } else {
        this.expectWord("ON", CLAUSE_ERROR);
        on = this.parseExpression(depth);
        if (containsAggregate(on)) throw new Error("JOIN ON cannot contain aggregate expressions.");
      }
      joins.push(this.node({ type: joinType, source, on }));
    }
    let where;
    const groupBy = [];
    let having;
    const orderBy = [];
    let limit;
    let offset = 0;
    if (this.consumeWord("WHERE")) {
      where = this.parseExpression(depth);
      if (containsAggregate(where)) throw new Error("WHERE cannot contain aggregate expressions.");
    }
    if (this.consumeWord("GROUP")) {
      this.expectWord("BY", "GROUP must be followed by BY.");
      do {
        const expression = this.parseExpression(depth);
        if (containsAggregate(expression)) throw new Error("GROUP BY cannot contain aggregate expressions.");
        groupBy.push(expression);
      } while (this.consumePunct(","));
    }
    if (this.consumeWord("HAVING")) having = this.parseExpression(depth);
    if (this.consumeWord("ORDER")) {
      this.expectWord("BY", "ORDER must be followed by BY.");
      do {
        const expression = this.parseExpression(depth);
        let direction = "asc";
        if (this.consumeWord("ASC")) direction = "asc";
        else if (this.consumeWord("DESC")) direction = "desc";
        orderBy.push(this.node({ expression, direction }));
      } while (this.consumePunct(","));
    }
    if (this.consumeWord("LIMIT")) limit = this.parseNonNegativeInteger("LIMIT");
    if (this.consumeWord("OFFSET")) offset = this.parseNonNegativeInteger("OFFSET");
    if (!this.atSelectEnd()) throw new Error(CLAUSE_ERROR);
    const outputNames = new Set();
    for (const item of selectItems) {
      if (item.kind === "star") continue;
      if (outputNames.has(item.output)) throw new Error(`Duplicate SQL output column: ${item.output}.`);
      outputNames.add(item.output);
    }
    const part = this.node({
      type: "select",
      distinct,
      selectItems,
      from,
      joins,
      where,
      groupBy,
      having,
      orderBy,
      limit,
      offset,
      parameterStart,
      parameterCount: this.parameterCount - parameterStart,
      raw: this.tokens.slice(start, this.index).map((item) => item.raw).join(" "),
    });
    this.validateSelect(part);
    this.activeScope = previousScope;
    return part;
  }

  atSelectEnd() {
    return this.index >= this.tokens.length || isPunct(this.peek(), ")") || isWord(this.peek(), "UNION");
  }

  parseNonNegativeInteger(label) {
    const item = this.peek();
    if (item?.type !== "number" || !Number.isSafeInteger(item.value) || item.value < 0) {
      throw new Error(`${label} requires a non-negative safe integer.`);
    }
    this.index += 1;
    return item.value;
  }

  parseSource(scope) {
    if (this.consumePunct("(")) throw new Error("FROM subqueries are not supported; use a bounded CTE instead.");
    const item = this.peek();
    const name = identifierValue(item, "FROM source");
    this.index += 1;
    let source;
    if (item.type === "identifier" && SOURCE_PATTERN.test(name)) {
      this.addSource(name);
      source = { kind: "physical", url: name, name };
    } else {
      const key = name.toLowerCase();
      if (!scope.has(key)) throw new Error("FROM must name a quoted collection:// data source or an in-scope CTE.");
      source = { kind: "cte", key, name };
    }
    let alias = source.kind === "cte" ? source.name : source.url;
    if (this.consumeWord("AS")) alias = this.parseIdentifier("source alias");
    else if (this.canBareAlias(this.peek())) alias = this.parseIdentifier("source alias");
    return this.node({ ...source, alias, aliasKey: alias.toLowerCase() });
  }

  canBareAlias(item) {
    if (item?.type === "identifier") return true;
    return item?.type === "word" && !ALIAS_STOP_WORDS.has(String(item.value).toUpperCase());
  }

  parseSelectItem(depth) {
    const start = this.index;
    let kind = "expression";
    let qualifier = null;
    let expression;
    if (this.consumePunct("*")) {
      kind = "star";
    } else if (
      (this.peek()?.type === "identifier" || this.peek()?.type === "word") &&
      isPunct(this.peek(1), ".") &&
      isPunct(this.peek(2), "*")
    ) {
      qualifier = identifierValue(this.peek(), "star qualifier");
      this.index += 3;
      kind = "star";
    } else {
      expression = this.parseExpression(depth);
    }
    let alias = null;
    if (this.consumeWord("AS")) alias = this.parseIdentifier("SELECT alias");
    else if (kind !== "star" && this.canBareAlias(this.peek())) alias = this.parseIdentifier("SELECT alias");
    if (kind === "star" && alias) throw new Error("SELECT * cannot have an alias.");
    const raw = this.tokens.slice(start, this.index).map((item) => item.raw).join(" ");
    if (kind === "star") return this.node({ kind, qualifier, raw });
    const output = alias ?? this.defaultOutputName(expression, raw);
    return this.node({ kind, expression, output, raw });
  }

  defaultOutputName(expression, raw) {
    if (expression.type === "column") return expression.name;
    if (expression.type === "call" && expression.aggregate) return expression.name.toLowerCase();
    return raw;
  }

  validateSelect(part) {
    const selectAggregates = part.selectItems.some((item) => item.expression && containsAggregate(item.expression));
    const aggregateMode = selectAggregates || part.groupBy.length > 0 || containsAggregate(part.having) ||
      part.orderBy.some((item) => containsAggregate(item.expression));
    if (part.having && !aggregateMode) throw new Error("HAVING requires GROUP BY or an aggregate expression.");
    if (!aggregateMode) return;
    const groupKeys = new Set(part.groupBy.map(expressionKey));
    for (const item of part.selectItems) {
      if (item.kind === "star") throw new Error("SELECT * cannot be combined with GROUP BY or aggregate expressions.");
      if (containsAggregate(item.expression) || !containsColumnOutsideAggregate(item.expression)) continue;
      if (!groupKeys.has(expressionKey(item.expression))) {
        throw new Error(`SELECT expression ${item.raw} must appear in GROUP BY.`);
      }
    }
  }

  parseExpression(depth = 0) {
    this.checkDepth(depth);
    return this.parseOr(depth);
  }

  parseOr(depth) {
    let left = this.parseAnd(depth);
    while (this.consumeWord("OR")) left = this.node({ type: "binary", operator: "OR", left, right: this.parseAnd(depth) });
    return left;
  }

  parseAnd(depth) {
    let left = this.parseNot(depth);
    while (this.consumeWord("AND")) left = this.node({ type: "binary", operator: "AND", left, right: this.parseNot(depth) });
    return left;
  }

  parseNot(depth) {
    if (this.consumeWord("NOT")) return this.node({ type: "unary", operator: "NOT", value: this.parseNot(depth + 1) });
    return this.parseComparison(depth);
  }

  parseComparison(depth) {
    let left = this.parseConcat(depth);
    if (this.consumeWord("IS")) {
      const negated = this.consumeWord("NOT");
      this.expectWord("NULL", "IS only supports NULL or NOT NULL.");
      return this.node({ type: "is_null", value: left, negated });
    }
    let negated = false;
    if (isWord(this.peek(), "NOT") && (isWord(this.peek(1), "IN") || isWord(this.peek(1), "LIKE"))) {
      this.index += 1;
      negated = true;
    }
    if (this.consumeWord("IN")) {
      this.expectPunct("(", "IN requires a parenthesized value list or SELECT.");
      if (isWord(this.peek(), "SELECT") || isWord(this.peek(), "WITH")) {
        const query = this.parseNestedQuery(depth + 1);
        this.expectPunct(")", "IN subquery is missing a closing parenthesis.");
        return this.node({ type: "in", value: left, query, negated });
      }
      const values = [];
      if (!isPunct(this.peek(), ")")) {
        do values.push(this.parseExpression(depth + 1));
        while (this.consumePunct(","));
      }
      this.expectPunct(")", "IN values must be comma-separated and close with ).");
      if (!values.length) throw new Error("IN requires at least one value.");
      return this.node({ type: "in", value: left, values, negated });
    }
    if (this.consumeWord("LIKE")) {
      return this.node({ type: "binary", operator: negated ? "NOT LIKE" : "LIKE", left, right: this.parseConcat(depth) });
    }
    if (negated) throw new Error("NOT after an expression is supported only with IN or LIKE.");
    const operator = this.peek();
    if (operator?.type === "operator" && ["=", "!=", "<>", ">=", "<=", ">", "<"].includes(operator.value)) {
      this.index += 1;
      left = this.node({ type: "binary", operator: operator.value, left, right: this.parseConcat(depth) });
    }
    return left;
  }

  parseConcat(depth) {
    let left = this.parseAdditive(depth);
    while (this.peek()?.type === "operator" && this.peek().value === "||") {
      this.index += 1;
      left = this.node({ type: "binary", operator: "||", left, right: this.parseAdditive(depth) });
    }
    return left;
  }

  parseAdditive(depth) {
    let left = this.parseMultiplicative(depth);
    while (this.peek()?.type === "operator" && ["+", "-"].includes(this.peek().value)) {
      const operator = this.peek().value;
      this.index += 1;
      left = this.node({ type: "binary", operator, left, right: this.parseMultiplicative(depth) });
    }
    return left;
  }

  parseMultiplicative(depth) {
    let left = this.parseUnaryNumeric(depth);
    while (
      (isPunct(this.peek(), "*") || this.peek()?.type === "operator") &&
      ["*", "/", "%"].includes(this.peek().value)
    ) {
      const operator = this.peek().value;
      this.index += 1;
      left = this.node({ type: "binary", operator, left, right: this.parseUnaryNumeric(depth) });
    }
    return left;
  }

  parseUnaryNumeric(depth) {
    if (this.peek()?.type === "operator" && ["+", "-"].includes(this.peek().value)) {
      const operator = this.peek().value;
      this.index += 1;
      return this.node({ type: "unary", operator, value: this.parseUnaryNumeric(depth + 1) });
    }
    return this.parsePrimary(depth);
  }

  parsePrimary(depth) {
    this.checkDepth(depth);
    if (this.consumePunct("(")) {
      if (isWord(this.peek(), "SELECT") || isWord(this.peek(), "WITH")) {
        const query = this.parseNestedQuery(depth + 1);
        this.expectPunct(")", "Scalar subquery is missing a closing parenthesis.");
        return this.node({ type: "subquery", query });
      }
      const expression = this.parseExpression(depth + 1);
      this.expectPunct(")", "SQL expression is missing a closing parenthesis.");
      return expression;
    }
    if (this.consumeWord("EXISTS")) {
      this.expectPunct("(", "EXISTS requires a parenthesized SELECT.");
      const query = this.parseNestedQuery(depth + 1);
      this.expectPunct(")", "EXISTS subquery is missing a closing parenthesis.");
      return this.node({ type: "exists", query });
    }
    if (this.consumeWord("CASE")) return this.parseCase(depth + 1);
    const item = this.peek();
    if (!item) throw new Error("SQL expression is incomplete.");
    if (item.type === "param") {
      this.index += 1;
      const index = this.parameterCount;
      this.parameterCount += 1;
      if (this.parameterCount > NOTION_MCP_SQL_LIMITS.maxParams) {
        throw new Error(`SQL accepts at most ${NOTION_MCP_SQL_LIMITS.maxParams} parameters.`);
      }
      return this.node({ type: "param", index });
    }
    if (item.type === "number" || item.type === "string") {
      this.index += 1;
      return this.node({ type: "literal", value: item.value });
    }
    if (item.type !== "identifier" && item.type !== "word") {
      throw new Error(`Unsupported SQL expression near ${item.raw}.`);
    }
    if (item.type === "word") {
      const upper = String(item.value).toUpperCase();
      if (["NULL", "TRUE", "FALSE", "__YES__", "__NO__"].includes(upper)) {
        this.index += 1;
        const value = upper === "NULL" ? null : upper === "TRUE" || upper === "__YES__";
        return this.node({ type: "literal", value });
      }
    }
    const name = String(item.value);
    if (isPunct(this.peek(1), "(")) return this.parseFunction(depth, name);
    this.index += 1;
    let qualifier = null;
    let column = name;
    if (this.consumePunct(".")) {
      qualifier = name;
      column = this.parseIdentifier("qualified property");
    }
    return this.node({ type: "column", qualifier, name: column });
  }

  parseFunction(depth, rawName) {
    const name = rawName.toUpperCase();
    const aggregate = AGGREGATE_FUNCTIONS.has(name);
    if (!aggregate && !SCALAR_FUNCTIONS.has(name)) throw new Error(`Unsupported SQL function: ${rawName}.`);
    this.index += 2;
    let distinct = false;
    const argumentsList = [];
    let star = false;
    if (aggregate && this.consumeWord("DISTINCT")) distinct = true;
    if (aggregate && this.consumePunct("*")) {
      if (name !== "COUNT" || distinct) throw new Error(`${name}(*) is not supported in that form.`);
      star = true;
    } else if (!this.consumePunct(")")) {
      do argumentsList.push(this.parseExpression(depth + 1));
      while (this.consumePunct(","));
      this.expectPunct(")", `${name} must close with ).`);
      return this.validateFunction(this.node({ type: "call", name, aggregate, distinct, star, arguments: argumentsList }));
    }
    this.expectPunct(")", `${name} must close with ).`);
    return this.validateFunction(this.node({ type: "call", name, aggregate, distinct, star, arguments: argumentsList }));
  }

  validateFunction(expression) {
    const { name, aggregate, star, arguments: argumentsList } = expression;
    if (aggregate) {
      if (!star && argumentsList.length !== 1) throw new Error(`${name} requires exactly one expression.`);
      if (argumentsList.some(containsAggregate)) throw new Error("Nested aggregate expressions are not supported.");
      return expression;
    }
    const expected = {
      ABS: [1, 1], COALESCE: [1, 32], IFNULL: [2, 2], LENGTH: [1, 1], LOWER: [1, 1],
      NULLIF: [2, 2], ROUND: [1, 2], UPPER: [1, 1],
    }[name];
    if (argumentsList.length < expected[0] || argumentsList.length > expected[1]) {
      throw new Error(`${name} accepts ${expected[0] === expected[1] ? expected[0] : `${expected[0]}-${expected[1]}`} argument(s).`);
    }
    return expression;
  }

  parseCase(depth) {
    this.checkDepth(depth);
    let base = null;
    if (!isWord(this.peek(), "WHEN")) base = this.parseExpression(depth);
    const branches = [];
    while (this.consumeWord("WHEN")) {
      const when = this.parseExpression(depth);
      this.expectWord("THEN", "CASE WHEN requires THEN.");
      const then = this.parseExpression(depth);
      branches.push({ when, then });
    }
    if (!branches.length) throw new Error("CASE requires at least one WHEN branch.");
    let otherwise = this.node({ type: "literal", value: null });
    if (this.consumeWord("ELSE")) otherwise = this.parseExpression(depth);
    this.expectWord("END", "CASE expression requires END.");
    return this.node({ type: "case", base, branches, otherwise });
  }

  parseNestedQuery(depth) {
    this.subqueryCount += 1;
    if (this.subqueryCount > NOTION_MCP_SQL_LIMITS.maxSubqueries) {
      throw new Error(`SQL may contain at most ${NOTION_MCP_SQL_LIMITS.maxSubqueries} subqueries.`);
    }
    return this.parseQuery(this.activeScope, depth);
  }
}

function legacyColumnName(expression) {
  return expression?.type === "column" && !expression.qualifier ? expression.name : undefined;
}

function legacyPart(select, dataSourceUrl, nodeCount) {
  const firstOrder = select.orderBy[0];
  const selectItems = select.selectItems.map((item) => {
    if (item.kind === "star") return { kind: "star", qualifier: item.qualifier, output: "*" };
    if (item.expression.type === "column") {
      return { kind: "column", source: item.expression.name, qualifier: item.expression.qualifier, output: item.output, expression: item.expression };
    }
    if (item.expression.type === "call" && item.expression.aggregate) {
      const argument = item.expression.arguments[0];
      return {
        kind: "aggregate",
        reference: {
          kind: "aggregate",
          function: item.expression.name,
          column: item.expression.star ? null : legacyColumnName(argument),
        },
        output: item.output,
        expression: item.expression,
      };
    }
    return { kind: "expression", output: item.output, expression: item.expression };
  });
  return {
    select: select.selectItems.map((item) => item.raw).join(", "),
    selectItems,
    distinct: select.distinct,
    dataSourceUrl,
    where: select.where ? expressionKey(select.where) : undefined,
    whereAst: select.where,
    groupBy: select.groupBy.map((item) => legacyColumnName(item) ?? expressionKey(item)),
    groupByAst: select.groupBy,
    having: select.having ? expressionKey(select.having) : undefined,
    havingAst: select.having,
    orderBy: firstOrder ? legacyColumnName(firstOrder.expression) ?? (
      firstOrder.expression.type === "column" ? firstOrder.expression.name : undefined
    ) : undefined,
    orderDirection: firstOrder?.direction ?? "asc",
    orderKeys: select.orderBy,
    limit: select.limit,
    offset: select.offset,
    parameterCount: select.parameterCount,
    nodeCount,
  };
}

function parseSql(query) {
  if (typeof query !== "string" || !query.trim()) throw new Error("query is required.");
  let sql = query.trim();
  if (sqlByteLength(sql) > NOTION_MCP_SQL_LIMITS.maxSqlBytes) {
    throw new Error(`SQL exceeds ${NOTION_MCP_SQL_LIMITS.maxSqlBytes} UTF-8 bytes.`);
  }
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  const parser = new SqlParser(tokenizeSql(sql));
  const queryAst = parser.parseQuery(new Map(), 0);
  if (parser.index !== parser.tokens.length) throw new Error(CLAUSE_ERROR);
  const rootSelect = queryAst.compound.parts[0];
  const basePart = legacyPart(rootSelect, parser.sourceUrls[0], parser.nodeCount);
  const parts = parser.sourceUrls.map((dataSourceUrl, index) => ({
    ...basePart,
    dataSourceUrl,
    parameterCount: index === 0 ? parser.parameterCount : 0,
  }));
  const hasSingleResultSet = queryAst.compound.parts.length === 1;
  return {
    parts,
    queryParts: queryAst.compound.parts.map((part) => legacyPart(part, parser.sourceUrls[0], parser.nodeCount)),
    operators: queryAst.compound.operators,
    query: queryAst,
    dataSourceUrls: [...parser.sourceUrls],
    nodeCount: parser.nodeCount,
    parameterCount: parser.parameterCount,
    hasSingleResultSet,
    cursor: {
      eligible: hasSingleResultSet,
      limit: rootSelect.limit,
      offset: rootSelect.offset,
    },
  };
}

export function parseNotionMcpSqlPart(query) {
  const parsed = parseSql(String(query ?? ""));
  if (parsed.query.compound.parts.length !== 1) throw new Error("A SQL part cannot contain UNION.");
  return {
    ...parsed.queryParts[0],
    dataSourceUrl: parsed.dataSourceUrls[0],
    parameterCount: parsed.parameterCount,
    query: parsed.query,
    dataSourceUrls: parsed.dataSourceUrls,
  };
}

export function parseNotionMcpSqlUnion(query) {
  return parseSql(query);
}

function normalizeSqlValue(value) {
  if (value === "__YES__") return true;
  if (value === "__NO__") return false;
  return value === undefined ? null : value;
}

function sqlTruth(value) {
  const normalized = normalizeSqlValue(value);
  if (normalized === null) return null;
  if (typeof normalized === "boolean") return normalized;
  if (typeof normalized === "number") return normalized !== 0 && !Number.isNaN(normalized);
  const number = Number(normalized);
  return Number.isFinite(number) ? number !== 0 : false;
}

function sqlNot(value) {
  const truth = sqlTruth(value);
  return truth === null ? null : !truth;
}

function sqlAnd(left, rightThunk) {
  const a = sqlTruth(left);
  if (a === false) return false;
  const b = sqlTruth(rightThunk());
  if (a === true) return b;
  return b === false ? false : null;
}

function sqlOr(left, rightThunk) {
  const a = sqlTruth(left);
  if (a === true) return true;
  const b = sqlTruth(rightThunk());
  if (a === false) return b;
  return b === true ? true : null;
}

function sqlEquals(left, right) {
  const a = normalizeSqlValue(left);
  const b = normalizeSqlValue(right);
  if (a === null || b === null) return null;
  if (typeof a === "object" || typeof b === "object") return stableValueKey(a) === stableValueKey(b);
  return String(a) === String(b);
}

function compareSort(left, right) {
  const a = normalizeSqlValue(left);
  const b = normalizeSqlValue(right);
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const numericA = Number(a);
  const numericB = Number(b);
  if (Number.isFinite(numericA) && Number.isFinite(numericB)) return numericA - numericB;
  return compareNaturalText(a, b);
}

function regexInsensitiveCodeUnit(value) {
  const upper = value.toUpperCase();
  if (upper.length !== 1) return value;
  if (value.charCodeAt(0) >= 0x80 && upper.charCodeAt(0) < 0x80) return value;
  return upper;
}

function likeLiteralEqual(left, right) {
  return left === right || regexInsensitiveCodeUnit(left) === regexInsensitiveCodeUnit(right);
}

function likeWildcardCanConsume(value) {
  return value !== "\n" && value !== "\r" && value !== "\u2028" && value !== "\u2029";
}

function sqlLikeMatches(value, pattern, state) {
  let valueIndex = 0;
  let patternIndex = 0;
  let lastPercentIndex = -1;
  let percentValueIndex = -1;

  while (valueIndex < value.length) {
    state.spend(1, "LIKE matching");
    const patternUnit = pattern[patternIndex];
    const valueUnit = value[valueIndex];
    if (patternUnit === "%") {
      lastPercentIndex = patternIndex;
      percentValueIndex = valueIndex;
      patternIndex += 1;
      continue;
    }
    if (
      (patternUnit === "_" && likeWildcardCanConsume(valueUnit))
      || (patternUnit !== undefined && patternUnit !== "_" && likeLiteralEqual(valueUnit, patternUnit))
    ) {
      valueIndex += 1;
      patternIndex += 1;
      continue;
    }
    if (
      lastPercentIndex >= 0
      && percentValueIndex < value.length
      && likeWildcardCanConsume(value[percentValueIndex])
    ) {
      percentValueIndex += 1;
      valueIndex = percentValueIndex;
      patternIndex = lastPercentIndex + 1;
      continue;
    }
    return false;
  }

  while (pattern[patternIndex] === "%") {
    state.spend(1, "LIKE matching");
    patternIndex += 1;
  }
  return patternIndex === pattern.length;
}

function compareSql(left, operator, right, state) {
  const a = normalizeSqlValue(left);
  const b = normalizeSqlValue(right);
  if (a === null || b === null) return null;
  if (operator === "LIKE" || operator === "NOT LIKE") {
    const matches = sqlLikeMatches(String(a), String(b), state);
    return operator === "NOT LIKE" ? !matches : matches;
  }
  if (operator === "=" || operator === "!=" || operator === "<>") {
    const equal = sqlEquals(a, b);
    return operator === "=" ? equal : !equal;
  }
  const comparison = compareSort(a, b);
  if (operator === ">=") return comparison >= 0;
  if (operator === "<=") return comparison <= 0;
  if (operator === ">") return comparison > 0;
  if (operator === "<") return comparison < 0;
  throw new Error(`Unsupported SQL comparison operator: ${operator}.`);
}

function relationSchema(rows) {
  const schema = new Set();
  for (const row of rows) for (const key of Object.keys(row)) schema.add(key);
  return { schema, unknown: rows.length === 0 };
}

function bindingValue(binding, name) {
  if (!binding.schema.has(name)) return undefined;
  return normalizeSqlValue(binding.row?.[name]);
}

function resolveColumn(expression, context, options = {}) {
  const qualifierKey = expression.qualifier?.toLowerCase();
  if (!qualifierKey && options.preferProjected && Object.prototype.hasOwnProperty.call(context.projected ?? {}, expression.name)) {
    return normalizeSqlValue(context.projected[expression.name]);
  }
  if (qualifierKey) {
    let current = context;
    while (current) {
      const binding = current.bindings.get(qualifierKey);
      if (binding) {
        if (binding.schema.has(expression.name)) return bindingValue(binding, expression.name);
        if (binding.schemaUnknown) return null;
        throw new Error(`Unknown SQL property ${expression.qualifier}.${expression.name}.`);
      }
      current = current.outer;
    }
    throw new Error(`Unknown SQL source alias: ${expression.qualifier}.`);
  }
  let current = context;
  while (current) {
    const candidates = [];
    const unknownCandidates = [];
    for (const binding of current.bindings.values()) {
      if (binding.schema.has(expression.name)) candidates.push(binding);
      else if (binding.schemaUnknown) unknownCandidates.push(binding);
    }
    if (candidates.length > 1 || (candidates.length === 0 && unknownCandidates.length > 1)) {
      throw new Error(`Ambiguous SQL property: ${expression.name}.`);
    }
    if (candidates.length === 1) return bindingValue(candidates[0], expression.name);
    if (unknownCandidates.length === 1) return null;
    current = current.outer;
  }
  if (options.preferProjected && Object.prototype.hasOwnProperty.call(context.projected ?? {}, expression.name)) {
    return normalizeSqlValue(context.projected[expression.name]);
  }
  throw new Error(`Unknown SQL property: ${expression.name}.`);
}

class SqlWorkState {
  constructor() {
    this.units = 0;
    this.schemaCache = new Map();
  }

  spend(count, label = "query") {
    this.units += Math.max(0, Math.trunc(count));
    if (this.units > NOTION_MCP_SQL_LIMITS.maxWorkUnits) {
      throw new Error(`SQL work exceeds ${NOTION_MCP_SQL_LIMITS.maxWorkUnits} row operations during ${label}.`);
    }
  }
}

function emptyContext(outer = null) {
  return { bindings: new Map(), projected: {}, group: null, outer };
}

function contextWithBinding(context, source, relation, row) {
  const bindings = new Map(context.bindings);
  bindings.set(source.aliasKey, {
    alias: source.alias,
    row,
    schema: relation.schema,
    schemaUnknown: relation.schemaUnknown,
  });
  return { bindings, projected: {}, group: null, outer: context.outer };
}

function nullContextFromTemplates(templates, outer) {
  const context = emptyContext(outer);
  for (const template of templates) {
    context.bindings.set(template.source.aliasKey, {
      alias: template.source.alias,
      row: null,
      schema: template.relation.schema,
      schemaUnknown: template.relation.schemaUnknown,
    });
  }
  return context;
}

function sourceRelation(source, runtime) {
  let rows;
  let schema;
  let schemaUnknown;
  if (source.kind === "physical") {
    if (!runtime.tables.has(source.url)) throw new Error(`SQL data source was not loaded: ${source.url}.`);
    rows = runtime.tables.get(source.url);
    if (!Array.isArray(rows)) throw new Error(`SQL data source ${source.url} must materialize as an array.`);
    if (!runtime.state.schemaCache.has(source.url)) runtime.state.schemaCache.set(source.url, relationSchema(rows));
    ({ schema, unknown: schemaUnknown } = runtime.state.schemaCache.get(source.url));
  } else {
    const cte = runtime.ctes.get(source.key);
    if (!cte) throw new Error(`SQL CTE was not materialized: ${source.name}.`);
    rows = cte.rows;
    schema = cte.schema;
    schemaUnknown = false;
  }
  runtime.state.spend(rows.length, `source ${source.name}`);
  return { rows, schema, schemaUnknown };
}

function scalarFunction(name, values) {
  if (name === "COALESCE") return values.find((value) => normalizeSqlValue(value) !== null) ?? null;
  if (name === "IFNULL") return normalizeSqlValue(values[0]) === null ? normalizeSqlValue(values[1]) : normalizeSqlValue(values[0]);
  if (name === "NULLIF") return sqlEquals(values[0], values[1]) === true ? null : normalizeSqlValue(values[0]);
  if (values.some((value) => normalizeSqlValue(value) === null)) return null;
  if (name === "LOWER") return String(values[0]).toLowerCase();
  if (name === "UPPER") return String(values[0]).toUpperCase();
  if (name === "LENGTH") return [...String(values[0])].length;
  if (name === "ABS") {
    const number = Number(values[0]);
    return Number.isFinite(number) ? Math.abs(number) : null;
  }
  if (name === "ROUND") {
    const number = Number(values[0]);
    const digits = values.length > 1 ? Math.trunc(Number(values[1])) : 0;
    if (!Number.isFinite(number) || !Number.isFinite(digits)) return null;
    const factor = 10 ** Math.max(-15, Math.min(15, digits));
    return Math.round(number * factor) / factor;
  }
  throw new Error(`Unsupported SQL function: ${name}.`);
}

function aggregateValue(expression, context, runtime) {
  const group = context.group ?? [];
  let values = expression.star
    ? group.map(() => 1)
    : group.map((rowContext) => evaluateExpression(expression.arguments[0], rowContext, runtime));
  if (expression.distinct) values = [...new Map(values.map((value) => [stableValueKey(normalizeSqlValue(value)), value])).values()];
  if (expression.name === "COUNT") {
    return expression.star ? group.length : values.filter((value) => normalizeSqlValue(value) !== null).length;
  }
  const nonNull = values.map(normalizeSqlValue).filter((value) => value !== null);
  if (expression.name === "SUM" || expression.name === "AVG") {
    const numbers = nonNull
      .filter((value) => typeof value !== "object" && value !== "")
      .map(Number)
      .filter(Number.isFinite);
    if (!numbers.length) return null;
    const sum = numbers.reduce((total, value) => total + value, 0);
    return expression.name === "SUM" ? sum : sum / numbers.length;
  }
  if (!nonNull.length) return null;
  return nonNull.reduce((selected, value) => {
    const compared = compareSort(value, selected);
    if (expression.name === "MIN") return compared < 0 ? value : selected;
    return compared > 0 ? value : selected;
  });
}

function firstSubqueryColumn(execution) {
  const first = execution.rows[0];
  if (!first) return null;
  const key = Object.keys(first)[0];
  return key === undefined ? null : normalizeSqlValue(first[key]);
}

function evaluateExpression(expression, context, runtime, options = {}) {
  runtime.state.spend(1, "expression evaluation");
  if (expression.type === "literal") return expression.value;
  if (expression.type === "param") return normalizeSqlValue(runtime.params[expression.index]);
  if (expression.type === "column") return resolveColumn(expression, context, options);
  if (expression.type === "unary") {
    const value = evaluateExpression(expression.value, context, runtime, options);
    if (expression.operator === "NOT") return sqlNot(value);
    if (normalizeSqlValue(value) === null) return null;
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return expression.operator === "-" ? -number : number;
  }
  if (expression.type === "is_null") {
    const isNull = normalizeSqlValue(evaluateExpression(expression.value, context, runtime, options)) === null;
    return expression.negated ? !isNull : isNull;
  }
  if (expression.type === "binary") {
    const left = evaluateExpression(expression.left, context, runtime, options);
    if (expression.operator === "AND") return sqlAnd(left, () => evaluateExpression(expression.right, context, runtime, options));
    if (expression.operator === "OR") return sqlOr(left, () => evaluateExpression(expression.right, context, runtime, options));
    const right = evaluateExpression(expression.right, context, runtime, options);
    if (["=", "!=", "<>", ">=", "<=", ">", "<", "LIKE", "NOT LIKE"].includes(expression.operator)) {
      return compareSql(left, expression.operator, right, runtime.state);
    }
    const a = normalizeSqlValue(left);
    const b = normalizeSqlValue(right);
    if (a === null || b === null) return null;
    if (expression.operator === "||") return String(a) + String(b);
    const numericA = Number(a);
    const numericB = Number(b);
    if (!Number.isFinite(numericA) || !Number.isFinite(numericB)) return null;
    if (expression.operator === "+") return numericA + numericB;
    if (expression.operator === "-") return numericA - numericB;
    if (expression.operator === "*") return numericA * numericB;
    if ((expression.operator === "/" || expression.operator === "%") && numericB === 0) return null;
    if (expression.operator === "/") return numericA / numericB;
    if (expression.operator === "%") return numericA % numericB;
  }
  if (expression.type === "call") {
    if (expression.aggregate) return aggregateValue(expression, context, runtime);
    return scalarFunction(expression.name, expression.arguments.map((item) => evaluateExpression(item, context, runtime, options)));
  }
  if (expression.type === "case") {
    if (expression.base) {
      const base = evaluateExpression(expression.base, context, runtime, options);
      for (const branch of expression.branches) {
        if (sqlEquals(base, evaluateExpression(branch.when, context, runtime, options)) === true) {
          return evaluateExpression(branch.then, context, runtime, options);
        }
      }
    } else {
      for (const branch of expression.branches) {
        if (sqlTruth(evaluateExpression(branch.when, context, runtime, options)) === true) {
          return evaluateExpression(branch.then, context, runtime, options);
        }
      }
    }
    return evaluateExpression(expression.otherwise, context, runtime, options);
  }
  if (expression.type === "subquery" || expression.type === "exists") {
    const execution = executeQueryAst(expression.query, { ...runtime, outer: context }, { topLevel: false });
    return expression.type === "exists" ? execution.rows.length > 0 : firstSubqueryColumn(execution);
  }
  if (expression.type === "in") {
    const left = normalizeSqlValue(evaluateExpression(expression.value, context, runtime, options));
    const values = expression.query
      ? executeQueryAst(expression.query, { ...runtime, outer: context }, { topLevel: false }).rows.map((row) => {
        const key = Object.keys(row)[0];
        return key === undefined ? null : normalizeSqlValue(row[key]);
      })
      : expression.values.map((item) => normalizeSqlValue(evaluateExpression(item, context, runtime, options)));
    if (left === null) return null;
    let sawNull = false;
    for (const value of values) {
      if (value === null) sawNull = true;
      else if (sqlEquals(left, value) === true) return expression.negated ? false : true;
    }
    const result = sawNull ? null : false;
    return expression.negated ? sqlNot(result) : result;
  }
  throw new Error(`Unsupported SQL expression node: ${expression.type}.`);
}

function joinContexts(contexts, templates, join, runtime) {
  const relation = sourceRelation(join.source, runtime);
  const nextTemplates = [...templates, { source: join.source, relation }];
  if (join.type === "cross" && contexts.length * relation.rows.length > NOTION_MCP_SQL_LIMITS.maxJoinRows) {
    throw new Error(`SQL join cardinality exceeds ${NOTION_MCP_SQL_LIMITS.maxJoinRows} rows.`);
  }
  const output = [];
  const matchedRight = new Set();
  for (const left of contexts) {
    let matched = false;
    for (let index = 0; index < relation.rows.length; index += 1) {
      runtime.state.spend(1, `${join.type} join`);
      const combined = contextWithBinding(left, join.source, relation, relation.rows[index]);
      if (join.type === "cross" || sqlTruth(evaluateExpression(join.on, combined, runtime)) === true) {
        matched = true;
        matchedRight.add(index);
        output.push(combined);
        if (output.length > NOTION_MCP_SQL_LIMITS.maxJoinRows) {
          throw new Error(`SQL join cardinality exceeds ${NOTION_MCP_SQL_LIMITS.maxJoinRows} rows.`);
        }
      }
    }
    if (!matched && (join.type === "left" || join.type === "full")) {
      output.push(contextWithBinding(left, join.source, relation, null));
    }
  }
  if (join.type === "right" || join.type === "full") {
    for (let index = 0; index < relation.rows.length; index += 1) {
      if (matchedRight.has(index)) continue;
      const nullLeft = nullContextFromTemplates(templates, runtime.outer ?? null);
      output.push(contextWithBinding(nullLeft, join.source, relation, relation.rows[index]));
      if (output.length > NOTION_MCP_SQL_LIMITS.maxJoinRows) {
        throw new Error(`SQL join cardinality exceeds ${NOTION_MCP_SQL_LIMITS.maxJoinRows} rows.`);
      }
    }
  }
  return { contexts: output, templates: nextTemplates };
}

function groupContexts(contexts, groupBy, runtime) {
  if (!groupBy.length) return [contexts];
  const groups = new Map();
  for (const context of contexts) {
    runtime.state.spend(1, "GROUP BY");
    const key = stableValueKey(groupBy.map((expression) => evaluateExpression(expression, context, runtime)));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(context);
  }
  return [...groups.values()];
}

function projectionSchema(selectItems, templates) {
  const schema = [];
  const seen = new Set();
  const add = (name) => {
    if (seen.has(name)) throw new Error(`Duplicate or ambiguous SQL output column: ${name}.`);
    seen.add(name);
    schema.push(name);
  };
  for (const item of selectItems) {
    if (item.kind !== "star") {
      add(item.output);
      continue;
    }
    const selected = item.qualifier
      ? templates.filter((template) => template.source.aliasKey === item.qualifier.toLowerCase())
      : templates;
    if (item.qualifier && selected.length !== 1) throw new Error(`Unknown SQL source alias: ${item.qualifier}.`);
    for (const template of selected) for (const name of template.relation.schema) add(name);
  }
  return schema;
}

function projectContext(selectItems, context, templates, runtime) {
  const projected = {};
  for (const item of selectItems) {
    if (item.kind !== "star") {
      projected[item.output] = normalizeSqlValue(evaluateExpression(item.expression, context, runtime));
      continue;
    }
    const selected = item.qualifier
      ? templates.filter((template) => template.source.aliasKey === item.qualifier.toLowerCase())
      : templates;
    for (const template of selected) {
      const binding = context.bindings.get(template.source.aliasKey);
      for (const name of template.relation.schema) {
        if (Object.prototype.hasOwnProperty.call(projected, name)) {
          throw new Error(`Duplicate or ambiguous SQL output column: ${name}.`);
        }
        projected[name] = bindingValue(binding, name) ?? null;
      }
    }
  }
  return projected;
}

function executeSelect(select, runtime, options) {
  const baseRelation = sourceRelation(select.from, runtime);
  let templates = [{ source: select.from, relation: baseRelation }];
  let contexts = baseRelation.rows.map((row) => contextWithBinding(emptyContext(runtime.outer ?? null), select.from, baseRelation, row));
  for (const join of select.joins) {
    ({ contexts, templates } = joinContexts(contexts, templates, join, runtime));
  }
  if (contexts.length > NOTION_MCP_SQL_LIMITS.maxIntermediateRows) {
    throw new Error(`SQL intermediate result exceeds ${NOTION_MCP_SQL_LIMITS.maxIntermediateRows} rows.`);
  }
  if (select.where) {
    contexts = contexts.filter((context) => {
      runtime.state.spend(1, "WHERE");
      return sqlTruth(evaluateExpression(select.where, context, runtime)) === true;
    });
  }
  const aggregateMode = select.groupBy.length > 0 ||
    select.selectItems.some((item) => item.expression && containsAggregate(item.expression)) ||
    containsAggregate(select.having) || select.orderBy.some((item) => containsAggregate(item.expression));
  const schema = projectionSchema(select.selectItems, templates);
  let entries = [];
  if (aggregateMode) {
    for (const group of groupContexts(contexts, select.groupBy, runtime)) {
      const base = group[0] ?? emptyContext(runtime.outer ?? null);
      const context = { ...base, group, projected: {} };
      runtime.state.spend(1, "aggregate projection");
      const projected = projectContext(select.selectItems, context, templates, runtime);
      context.projected = projected;
      if (select.having && sqlTruth(evaluateExpression(select.having, context, runtime, { preferProjected: true })) !== true) continue;
      entries.push({ context, projected });
    }
  } else {
    entries = contexts.map((context) => {
      runtime.state.spend(1, "projection");
      const projected = projectContext(select.selectItems, context, templates, runtime);
      return { context: { ...context, projected }, projected };
    });
  }
  if (select.distinct) entries = [...new Map(entries.map((entry) => [stableValueKey(entry.projected), entry])).values()];
  if (select.orderBy.length) {
    runtime.state.spend(Math.ceil(entries.length * Math.log2(Math.max(2, entries.length))), "ORDER BY");
    for (const entry of entries) {
      entry.sortKeys = select.orderBy.map((order) => {
        if (order.expression.type === "literal" && Number.isInteger(order.expression.value) && order.expression.value > 0) {
          return Object.values(entry.projected)[order.expression.value - 1] ?? null;
        }
        return evaluateExpression(order.expression, entry.context, runtime, { preferProjected: true });
      });
    }
    entries.sort((left, right) => {
      for (let index = 0; index < select.orderBy.length; index += 1) {
        const compared = compareSort(left.sortKeys[index], right.sortKeys[index]);
        if (compared !== 0) return select.orderBy[index].direction === "desc" ? -compared : compared;
      }
      return 0;
    });
  }
  const total = entries.length;
  const offset = Math.max(0, Math.trunc(select.offset ?? 0));
  const requestedLimit = select.limit ?? (options.topLevel ? 100 : NOTION_MCP_SQL_LIMITS.maxIntermediateRows);
  const limitCap = options.topLevel ? NOTION_MCP_SQL_LIMITS.maxOutputRows : NOTION_MCP_SQL_LIMITS.maxIntermediateRows;
  const limit = Math.max(0, Math.min(limitCap, Math.trunc(requestedLimit)));
  const sliced = entries.slice(offset, offset + limit);
  return {
    rows: sliced.map((entry) => entry.projected),
    schema: new Set(schema),
    hasMore: offset + sliced.length < total,
  };
}

function remapRowsToSchema(rows, fromSchema, toSchema) {
  const sourceNames = [...fromSchema];
  const targetNames = [...toSchema];
  if (sourceNames.length !== targetNames.length) throw new Error("UNION SELECT parts must return the same number of columns.");
  return rows.map((row) => Object.fromEntries(targetNames.map((name, index) => [name, row[sourceNames[index]] ?? null])));
}

function executeCompound(compound, runtime, options) {
  let rows = [];
  let schema = null;
  let singleExecution = null;
  for (let index = 0; index < compound.parts.length; index += 1) {
    const execution = executeSelect(compound.parts[index], runtime, options);
    if (compound.parts.length === 1) singleExecution = execution;
    if (!schema) schema = execution.schema;
    const normalized = index === 0 ? execution.rows : remapRowsToSchema(execution.rows, execution.schema, schema);
    if (index === 0 || compound.operators[index - 1] === "all") rows.push(...normalized);
    else rows = [...new Map([...rows, ...normalized].map((row) => [stableValueKey(row), row])).values()];
    const cap = options.topLevel ? NOTION_MCP_SQL_LIMITS.maxOutputRows : NOTION_MCP_SQL_LIMITS.maxIntermediateRows;
    if (rows.length > cap) {
      throw new Error(options.topLevel
        ? `SQL output exceeds ${NOTION_MCP_SQL_LIMITS.maxOutputRows} rows. Narrow the query or add LIMIT.`
        : `SQL intermediate result exceeds ${NOTION_MCP_SQL_LIMITS.maxIntermediateRows} rows.`);
    }
  }
  return { rows, schema: schema ?? new Set(), hasMore: singleExecution?.hasMore === true };
}

function executeQueryAst(query, runtime, options) {
  const ctes = new Map(runtime.ctes ?? []);
  const nestedRuntime = { ...runtime, ctes };
  for (const cte of query.ctes) {
    const execution = executeQueryAst(cte.query, nestedRuntime, { topLevel: false });
    let rows = execution.rows;
    let schema = execution.schema;
    if (cte.columns.length) {
      if (cte.columns.length !== schema.size) throw new Error(`CTE ${cte.name} output column count does not match its declaration.`);
      const sourceNames = [...schema];
      rows = rows.map((row) => Object.fromEntries(cte.columns.map((name, index) => [name, row[sourceNames[index]] ?? null])));
      schema = new Set(cte.columns);
    }
    ctes.set(cte.key, { rows, schema });
  }
  return executeCompound(query.compound, nestedRuntime, options);
}

export function executeNotionMcpSql(parsed, params, tables) {
  if (!Array.isArray(params)) throw new Error("SQL params must be an array.");
  if (params.length > NOTION_MCP_SQL_LIMITS.maxParams) {
    throw new Error(`SQL accepts at most ${NOTION_MCP_SQL_LIMITS.maxParams} parameters.`);
  }
  if (params.length !== parsed.parameterCount) {
    throw new Error(`SQL expected ${parsed.parameterCount} parameter(s), but received ${params.length}.`);
  }
  if (!(tables instanceof Map)) throw new Error("SQL tables must be a Map.");
  const sourceUrls = parsed.dataSourceUrls ?? [...new Set(parsed.parts.map((part) => part.dataSourceUrl))];
  for (const url of sourceUrls) {
    if (!tables.has(url)) throw new Error(`SQL data source was not loaded: ${url}.`);
  }
  if (!parsed.query) throw new Error("SQL parse result is missing its bounded query AST.");
  const state = new SqlWorkState();
  const execution = executeQueryAst(parsed.query, {
    params: [...params],
    tables,
    ctes: new Map(),
    outer: null,
    state,
  }, { topLevel: true });
  return { results: execution.rows, hasMore: execution.hasMore };
}

function containsNestedSqlQuery(value) {
  if (!value || typeof value !== "object") return false;
  if (value.type === "subquery" || value.type === "exists") return true;
  if (Array.isArray(value)) return value.some(containsNestedSqlQuery);
  return Object.values(value).some(containsNestedSqlQuery);
}

export const NOTION_MCP_SQL_CROSS_WINDOW_ERROR =
  "SQL query requires cross-window state; DISTINCT, aggregate/grouping, JOIN, CTE/subquery, UNION, and computed ORDER BY are not supported by bounded source streaming.";

function directSourceOrder(select) {
  const orders = [];
  for (const order of select.orderBy ?? []) {
    const expression = order?.expression;
    if (expression?.type !== "column") return null;
    if (
      expression.qualifier
      && String(expression.qualifier).toLowerCase() !== String(select.from.aliasKey).toLowerCase()
    ) return null;
    const name = String(expression.name ?? "");
    if (!name) return null;
    const projectedAlias = select.selectItems?.find((item) =>
      item.kind === "expression"
      && String(item.output ?? "").toLowerCase() === name.toLowerCase()
    );
    if (
      projectedAlias
      && (
        projectedAlias.expression?.type !== "column"
        || String(projectedAlias.expression.name ?? "").toLowerCase() !== name.toLowerCase()
      )
    ) return null;
    orders.push({ property: name, direction: order.direction === "desc" ? "desc" : "asc" });
  }
  return orders;
}

/** Return the bounded source-stream plan for one physical SELECT. Direct
 * source-column ORDER BY terms are delegated to the canonical database query;
 * every operation that needs state across source windows is ineligible.
 */
export function notionMcpSqlStreamPlan(parsed) {
  const query = parsed?.query;
  const parts = query?.compound?.parts;
  if (!Array.isArray(parts) || parts.length !== 1 || query.ctes?.length) return null;
  const select = parts[0];
  if (
    select?.type !== "select"
    || select.from?.kind !== "physical"
    || select.distinct
    || select.joins?.length
    || select.groupBy?.length
    || select.having
    || containsNestedSqlQuery(select.where)
    || select.selectItems?.some((item) => containsNestedSqlQuery(item.expression))
    || select.selectItems?.some((item) => item.expression && containsAggregate(item.expression))
    || parsed.dataSourceUrls?.length !== 1
  ) return null;
  const orderBy = directSourceOrder(select);
  if (orderBy === null) return null;
  return {
    sourceUrl: select.from.url,
    orderBy,
  };
}

/**
 * Whether a query can be evaluated independently over ordered source chunks.
 * Direct source-column ordering is performed by the canonical source cursor;
 * this lane excludes every other operation that needs cross-chunk state.
 */
export function canStreamNotionMcpSql(parsed) {
  return notionMcpSqlStreamPlan(parsed) !== null;
}

/** Evaluate one physical source chunk without applying the query's global
 * OFFSET/LIMIT. The caller owns the cross-chunk offset and bounded output.
 */
export function executeStreamableNotionMcpSqlChunk(parsed, params, sourceUrl, rows) {
  if (!canStreamNotionMcpSql(parsed)) throw new Error("SQL query is not streamable by source chunk.");
  const select = parsed.query.compound.parts[0];
  const chunkParsed = {
    ...parsed,
    cursor: { ...parsed.cursor, offset: 0, limit: NOTION_MCP_SQL_LIMITS.maxOutputRows },
    query: {
      ...parsed.query,
      compound: {
        ...parsed.query.compound,
        parts: [{
          ...select,
          orderBy: [],
          offset: 0,
          limit: NOTION_MCP_SQL_LIMITS.maxOutputRows,
        }],
      },
    },
  };
  return executeNotionMcpSql(chunkParsed, params, new Map([[sourceUrl, rows]])).results;
}

export function applySimpleSqlWhere(rows, whereClause, params = []) {
  if (!whereClause) return rows;
  if (!Array.isArray(rows) || !Array.isArray(params)) throw new Error("SQL rows and params must be arrays.");
  const parser = new SqlParser(tokenizeSql(whereClause));
  parser.activeScope = new Map();
  const expression = parser.parseExpression(0);
  if (parser.index !== parser.tokens.length) throw new Error("Unsupported SQL predicate syntax.");
  if (containsAggregate(expression) || parser.sourceUrls.length) throw new Error("Simple SQL WHERE cannot contain aggregates or subqueries.");
  if (parser.parameterCount !== params.length) {
    throw new Error(`SQL expected ${parser.parameterCount} parameter(s), but received ${params.length}.`);
  }
  const schemaInfo = relationSchema(rows);
  const source = { alias: "source", aliasKey: "source" };
  const relation = { schema: schemaInfo.schema, schemaUnknown: schemaInfo.unknown };
  const state = new SqlWorkState();
  const runtime = { params: [...params], tables: new Map(), ctes: new Map(), outer: null, state };
  return rows.filter((row) => {
    state.spend(1, "WHERE");
    const context = contextWithBinding(emptyContext(), source, relation, row);
    return sqlTruth(evaluateExpression(expression, context, runtime)) === true;
  });
}

export function countSqlBindParameters(value) {
  if (!value) return 0;
  return tokenizeSql(value).filter((item) => item.type === "param").length;
}

const HELPER_SOURCE = "collection://sql-helper";

export function sqlCountProjectionAlias(select) {
  try {
    const parsed = parseSql(`SELECT ${select} FROM "${HELPER_SOURCE}"`);
    const items = parsed.query.compound.parts[0].selectItems;
    return items.length === 1 && items[0].expression?.type === "call" && items[0].expression.aggregate && items[0].expression.name === "COUNT"
      ? items[0].output
      : null;
  } catch {
    return null;
  }
}

export function selectSqlColumns(rows, select) {
  const parsed = parseSql(`SELECT ${select} FROM "${HELPER_SOURCE}"`);
  return executeNotionMcpSql(parsed, [], new Map([[HELPER_SOURCE, rows]])).results;
}

export const parseDataSourceSqlQuery = parseNotionMcpSqlPart;
export const parseDataSourceSqlUnionQuery = parseNotionMcpSqlUnion;
