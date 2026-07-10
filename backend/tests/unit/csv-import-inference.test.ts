import { describe, expect, it } from 'vitest';

import { inferCsvPropertyType, parseCsvDate } from '../../functions/import-export';

describe('parseCsvDate', () => {
  it('parses ISO, slash, and dot YMD forms', () => {
    expect(parseCsvDate('2026-03-01')).toBe('2026-03-01');
    expect(parseCsvDate('2026/05/20')).toBe('2026-05-20');
    expect(parseCsvDate('2026.05.20')).toBe('2026-05-20');
  });

  it('parses Korean spaced-dot and 년월일 forms', () => {
    expect(parseCsvDate('2026. 05. 20')).toBe('2026-05-20');
    expect(parseCsvDate('2026년 5월 20일')).toBe('2026-05-20');
    expect(parseCsvDate('2026년 5월 20')).toBe('2026-05-20');
  });

  it('rejects bare integers/years so numbers are not read as dates', () => {
    expect(parseCsvDate('1500')).toBeNull();
    expect(parseCsvDate('2026')).toBeNull();
  });

  it('rejects non-dates', () => {
    expect(parseCsvDate('not-a-date')).toBeNull();
    expect(parseCsvDate('')).toBeNull();
  });
});

describe('inferCsvPropertyType', () => {
  it('infers number, checkbox, and title-agnostic text', () => {
    expect(inferCsvPropertyType(['1500', '2,300.50', '-42', '900'])).toBe('number');
    expect(inferCsvPropertyType(['true', 'no', 'yes', 'false'])).toBe('checkbox');
    expect(inferCsvPropertyType(['Sales', 'Ops', 'Marketing'])).toBe('rich_text');
  });

  it('infers date even when a minority of cells are junk (the reported gap)', () => {
    // Previously one bad cell dropped the whole column to plain text.
    expect(inferCsvPropertyType(['2026-03-01', '2026-04-15', '2026/05/20', 'not-a-date'])).toBe('date');
  });

  it('ignores blank cells when deciding the type', () => {
    expect(inferCsvPropertyType(['2026-03-01', '', '2026-04-15', ''])).toBe('date');
    expect(inferCsvPropertyType(['10', '', '20', ''])).toBe('number');
  });

  it('does not mistype a mostly-text column, or a numeric column with junk, as a date', () => {
    expect(inferCsvPropertyType(['Sales', 'Ops', '2026-01-01'])).toBe('rich_text');
    // 2/3 numeric is below the ratio, and bare ints are not dates → stays text.
    expect(inferCsvPropertyType(['1500', '2300', 'abc'])).toBe('rich_text');
  });

  it('keeps checkbox strict — a partial boolean column is not a checkbox', () => {
    expect(inferCsvPropertyType(['yes', 'no', 'maybe'])).toBe('rich_text');
  });
});
