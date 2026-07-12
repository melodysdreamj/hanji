import { describe, expect, it } from 'vitest';

import {
  evaluateFormulaExpression,
  formatFormulaValue,
  formulaVariableNames,
  tokenizeFormula,
  type FormulaValue,
} from '../../../shared/database/formula-core';

const noProps = () => null;

function evaluate(expression: string, props: Record<string, FormulaValue> = {}, now?: Date) {
  return evaluateFormulaExpression(expression, (name) => props[name] ?? null, {
    now: now ? () => now : undefined,
  });
}

describe('tokenizeFormula', () => {
  it('tokenizes numbers, strings, identifiers, and operators', () => {
    expect(tokenizeFormula('prop("Price") * 2 >= 10')).toEqual([
      { type: 'identifier', value: 'prop' },
      { type: 'paren', value: '(' },
      { type: 'string', value: 'Price' },
      { type: 'paren', value: ')' },
      { type: 'operator', value: '*' },
      { type: 'number', value: '2' },
      { type: 'operator', value: '>=' },
      { type: 'number', value: '10' },
    ]);
  });

  it('handles escaped quotes and single-quoted strings', () => {
    expect(tokenizeFormula('"a\\"b"')).toEqual([{ type: 'string', value: 'a"b' }]);
    expect(tokenizeFormula("'hi'")).toEqual([{ type: 'string', value: 'hi' }]);
  });

  it('skips unknown characters without throwing', () => {
    expect(tokenizeFormula('1 @ 2')).toEqual([
      { type: 'number', value: '1' },
      { type: 'number', value: '2' },
    ]);
  });
});

describe('arithmetic and operators', () => {
  it('respects operator precedence', () => {
    expect(evaluate('1 + 2 * 3')).toBe(7);
    expect(evaluate('(1 + 2) * 3')).toBe(9);
    expect(evaluate('10 % 3 + 1')).toBe(2);
  });

  it('treats ^ as right-associative power', () => {
    expect(evaluate('2 ^ 3 ^ 2')).toBe(512);
  });

  it('supports unary minus', () => {
    expect(evaluate('-3 + 5')).toBe(2);
  });

  it('concatenates when either side of + is a string', () => {
    expect(evaluate('"a" + 1')).toBe('a1');
    expect(evaluate('1 + "a"')).toBe('1a');
  });

  it('compares equality on text form', () => {
    expect(evaluate('1 == "1"')).toBe(true);
    expect(evaluate('"a" != "b"')).toBe(true);
    expect(evaluate('2 > 1')).toBe(true);
    expect(evaluate('2 <= 1')).toBe(false);
  });
});

describe('prop resolution and conditionals', () => {
  it('resolves prop() through the resolver', () => {
    expect(evaluate('prop("Price") * 2', { Price: 21 })).toBe(42);
  });

  it('returns empty string for unknown identifiers', () => {
    expect(evaluate('mystery')).toBe('');
  });

  it('evaluates if() and ifs()', () => {
    expect(evaluate('if(true, "yes", "no")')).toBe('yes');
    expect(evaluate('if(prop("Done"), "yes", "no")', { Done: false })).toBe('no');
    expect(evaluate('ifs(false, "a", true, "b", "fallback")')).toBe('b');
    expect(evaluate('ifs(false, "a", false, "b", "fallback")')).toBe('fallback');
  });

  it('evaluates boolean helpers', () => {
    expect(evaluate('and(true, 1, "x")')).toBe(true);
    expect(evaluate('or(false, 0, "")')).toBe(false);
    expect(evaluate('not(0)')).toBe(true);
    expect(evaluate('empty(0)')).toBe(true);
    expect(evaluate('empty("x")')).toBe(false);
  });
});

describe('let bindings', () => {
  it('binds a single variable with let()', () => {
    expect(evaluate('let(x, 2, x * 3)')).toBe(6);
  });

  it('binds multiple variables with lets()', () => {
    expect(evaluate('lets(a, 1, b, 2, a + b)')).toBe(3);
  });

  it('restores shadowed variables after the call', () => {
    expect(evaluate('let(x, 1, let(x, 2, x) + x)')).toBe(3);
  });

  it('collects declared variable names', () => {
    const names = formulaVariableNames(tokenizeFormula('lets(a, 1, b, 2, a + b) + let(c, 3, c)'));
    expect(names).toEqual(new Set(['a', 'b', 'c']));
  });
});

describe('text functions', () => {
  it('handles casing, trim, and search helpers', () => {
    expect(evaluate('upper("abc")')).toBe('ABC');
    expect(evaluate('lower("ABC")')).toBe('abc');
    expect(evaluate('trim("  x  ")')).toBe('x');
    expect(evaluate('startsWith("hello", "he")')).toBe(true);
    expect(evaluate('endsWith("hello", "lo")')).toBe(true);
    expect(evaluate('contains("Hello", "he")')).toBe(true);
    expect(evaluate('length("abcd")')).toBe(4);
  });

  it('handles substring, repeat, and replace', () => {
    expect(evaluate('substring("abcdef", 1, 3)')).toBe('bc');
    expect(evaluate('substring("abcdef", 2)')).toBe('cdef');
    expect(evaluate('repeat("ab", 3)')).toBe('ababab');
    expect(evaluate('replace("a-b-c", "-", "+")')).toBe('a+b-c');
    expect(evaluate('replaceAll("a-b-c", "-", "+")')).toBe('a+b+c');
    expect(evaluate('test("abc123", "[0-9]+")')).toBe(true);
  });
});

describe('math functions', () => {
  it('aggregates numbers', () => {
    expect(evaluate('sum(1, 2, 3)')).toBe(6);
    expect(evaluate('mean(2, 4)')).toBe(3);
    expect(evaluate('median(1, 5, 3)')).toBe(3);
    expect(evaluate('median(1, 2, 3, 4)')).toBe(2.5);
    expect(evaluate('min(3, 1, 2)')).toBe(1);
    expect(evaluate('max(3, 1, 2)')).toBe(3);
  });

  it('rounds with precision', () => {
    expect(evaluate('round(3.14159, 2)')).toBe(3.14);
    expect(evaluate('round(2.5)')).toBe(3);
    expect(evaluate('floor(1.9)')).toBe(1);
    expect(evaluate('ceil(1.1)')).toBe(2);
    expect(evaluate('abs(-4)')).toBe(4);
  });

  it('coerces non-numeric input to 0 instead of NaN', () => {
    expect(evaluate('toNumber("abc")')).toBe(0);
    expect(evaluate('sum("abc", 2)')).toBe(2);
  });
});

describe('date functions', () => {
  it('uses the injected clock for now() and today()', () => {
    const now = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(evaluate('now()', {}, now)).toBe('2026-01-02T03:04:05Z');
    expect(evaluate('today()', {}, now)).toBe('2026-01-02');
  });

  it('adds and subtracts calendar units with month-end clamping', () => {
    expect(evaluate('dateAdd("2026-01-31", 1, "months")')).toBe('2026-02-28');
    expect(evaluate('dateAdd("2026-01-01", 2, "weeks")')).toBe('2026-01-15');
    expect(evaluate('dateSubtract("2026-01-10", 3, "days")')).toBe('2026-01-07');
  });

  it('computes dateBetween in several units', () => {
    expect(evaluate('dateBetween("2026-03-01", "2026-01-01", "months")')).toBe(2);
    expect(evaluate('dateBetween("2026-01-08", "2026-01-01", "weeks")')).toBe(1);
    expect(evaluate('dateBetween("2026-01-02", "2026-01-01", "hours")')).toBe(24);
  });

  it('extracts date parts and formats dates', () => {
    expect(evaluate('year("2026-07-04")')).toBe(2026);
    expect(evaluate('month("2026-07-04")')).toBe(7);
    expect(evaluate('day("2026-07-04")')).toBe(4);
    expect(evaluate('formatDate("2026-07-04", "YYYY/MM/DD")')).toBe('2026/07/04');
    expect(evaluate('formatDate("2026-07-04", "MMM D, YYYY")')).toBe('Jul 4, 2026');
  });

  it('handles date ranges and timestamps', () => {
    expect(evaluate('dateStart("2026-01-01T00:00:00Z/2026-01-05T00:00:00Z")')).toBe('2026-01-01');
    expect(evaluate('dateEnd("2026-01-01T00:00:00Z/2026-01-05T00:00:00Z")')).toBe('2026-01-05');
    expect(evaluate('timestamp("1970-01-01T00:00:00Z")')).toBe(0);
    expect(evaluate('fromTimestamp(0)')).toBe('1970-01-01T00:00:00Z');
  });

  it('rejects impossible calendar dates', () => {
    expect(evaluate('year("2026-02-31")')).toBe(0);
  });
});

describe('error tolerance', () => {
  it('returns empty string for empty or malformed expressions', () => {
    expect(evaluateFormulaExpression('', noProps)).toBe('');
    expect(evaluateFormulaExpression('   ', noProps)).toBe('');
    expect(evaluateFormulaExpression('(((', noProps)).toBe('');
    expect(evaluateFormulaExpression('unknownFn(1, 2)', noProps)).toBe('');
  });
});

describe('formatFormulaValue', () => {
  it('formats primitives and hides non-finite numbers', () => {
    expect(formatFormulaValue(null)).toBe('');
    expect(formatFormulaValue('')).toBe('');
    expect(formatFormulaValue(true)).toBe('true');
    expect(formatFormulaValue(false)).toBe('false');
    expect(formatFormulaValue(3)).toBe('3');
    expect(formatFormulaValue(1.23456789)).toBe('1.234568');
    expect(formatFormulaValue(Infinity)).toBe('');
    expect(formatFormulaValue('text')).toBe('text');
  });
});
