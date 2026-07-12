import { describe, expect, it } from 'vitest';
import {
  parsePersistentGeneratedLocale,
  persistentGeneratedLabels,
} from '../../lib/persistent-generated-labels';

describe('persistent generated labels', () => {
  it('keeps omitted protocol callers on the historical English contract', () => {
    const labels = persistentGeneratedLabels(parsePersistentGeneratedLocale(undefined));
    expect(labels.propertyNames.name).toBe('Name');
    expect(labels.viewNames.table).toBe('Table');
    expect(labels.columnName(2)).toBe('Column 2');
    expect(labels.copyName('')).toBe('Untitled copy');
  });

  it('generates Korean resource names for an explicit product locale', () => {
    const labels = persistentGeneratedLabels(parsePersistentGeneratedLocale('ko'));
    expect(labels.propertyNames.name).toBe('이름');
    expect(labels.viewNames.table).toBe('표');
    expect(labels.columnName(2)).toBe('열 2');
    expect(labels.copyName('')).toBe('제목 없음 사본');
  });

  it('rejects unsupported locale values rather than persisting mixed defaults', () => {
    expect(() => parsePersistentGeneratedLocale('ko-KR')).toThrow('locale must be "en" or "ko".');
    expect(() => parsePersistentGeneratedLocale(true)).toThrow('locale must be "en" or "ko".');
  });
});
