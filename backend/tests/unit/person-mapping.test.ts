import { describe, expect, it } from 'vitest';
import { remapPersonMentions, remapPersonPropertyValue } from '../../functions/person-mapping';

const MAP = new Map([['notion-user:abc', 'user-1']]);

describe('remapPersonPropertyValue', () => {
  const importedRef = {
    id: 'notion-user:abc',
    userId: 'notion-user:abc',
    notionUserId: 'abc',
    displayName: 'Kim',
    email: 'kim@example.com',
    notion: { object: 'user' },
  };

  it('maps an imported people array entry to a plain userId string', () => {
    const result = remapPersonPropertyValue([importedRef], MAP);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual(['user-1']);
  });

  it('maps a single created_by style object value', () => {
    const result = remapPersonPropertyValue(importedRef, MAP);
    expect(result.changed).toBe(true);
    expect(result.value).toBe('user-1');
  });

  it('keeps unmapped imported refs and native values untouched', () => {
    const other = { ...importedRef, id: 'notion-user:zzz', userId: 'notion-user:zzz' };
    const mixed = [other, 'user-9', importedRef];
    const result = remapPersonPropertyValue(mixed, MAP);
    expect(result.changed).toBe(true);
    expect(result.value).toEqual([other, 'user-9', 'user-1']);
  });

  it('does not touch non-person shapes', () => {
    for (const value of [null, 42, 'text', { notion: { type: 'select' } }, ['a', 'b']]) {
      const result = remapPersonPropertyValue(value, MAP);
      expect(result.changed).toBe(false);
      expect(result.value).toEqual(value);
    }
  });
});

describe('remapPersonMentions', () => {
  it('rewrites person mention spans and keeps provenance', () => {
    const content = {
      spans: [
        { text: 'hello ' },
        {
          text: '@Kim',
          mention: 'person',
          userId: 'notion-user:abc',
          notionUser: { userId: 'notion-user:abc', displayName: 'Kim' },
        },
      ],
    };
    let hits = 0;
    const result = remapPersonMentions(content, MAP, () => {
      hits += 1;
    });
    expect(result.changed).toBe(true);
    expect(hits).toBe(1);
    const spans = (result.value as { spans: Array<Record<string, unknown>> }).spans;
    expect(spans[1].userId).toBe('user-1');
    expect((spans[1].notionUser as Record<string, unknown>).userId).toBe('notion-user:abc');
    // The original object is not mutated.
    expect(content.spans[1].userId).toBe('notion-user:abc');
  });

  it('walks nested structures and leaves unmapped mentions alone', () => {
    const content = {
      rows: [
        { cells: [{ spans: [{ mention: 'person', userId: 'notion-user:zzz' }] }] },
        { cells: [{ spans: [{ mention: 'person', userId: 'notion-user:abc' }] }] },
      ],
    };
    const result = remapPersonMentions(content, MAP);
    expect(result.changed).toBe(true);
    const rows = (result.value as { rows: Array<{ cells: Array<{ spans: Array<Record<string, unknown>> }> }> }).rows;
    expect(rows[0].cells[0].spans[0].userId).toBe('notion-user:zzz');
    expect(rows[1].cells[0].spans[0].userId).toBe('user-1');
  });

  it('reports no change for content without imported mentions', () => {
    const content = { spans: [{ text: 'plain' }, { mention: 'date', date: '2026-07-10' }] };
    const result = remapPersonMentions(content, MAP);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(content);
  });
});
