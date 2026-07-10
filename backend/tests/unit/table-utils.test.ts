import { describe, expect, it, vi } from 'vitest';

import {
  ABSOLUTE_LIST_ALL_MAX_ITEMS,
  DEFAULT_LIST_ALL_MAX_ITEMS,
  bestEffort,
  getExisting,
  listAll,
  requireString,
  requireStringRaw,
  type TableQuery,
} from '../../lib/table-utils';

describe('listAll', () => {
  function pagedQuery<T>(pages: T[][], hasMoreAfterLast = false): TableQuery<T> {
    const make = (pageNumber: number): TableQuery<T> => ({
      page: (n: number) => make(n),
      limit: () => make(pageNumber),
      getList: async () => ({
        items: pages[pageNumber - 1] ?? [],
        hasMore: pageNumber < pages.length || (pageNumber >= pages.length && hasMoreAfterLast),
      }),
    });
    return make(1);
  }

  it('concatenates pages until hasMore is false', async () => {
    expect(await listAll(pagedQuery([[1, 2], [3], [4]]))).toEqual([1, 2, 3, 4]);
  });

  it('stops on an empty final page without hasMore', async () => {
    expect(await listAll(pagedQuery([[1], []]))).toEqual([1]);
  });

  it('rejects an empty page that claims hasMore instead of looping or truncating', async () => {
    await expect(listAll(pagedQuery([[1], []], true))).rejects.toThrow(
      'empty page with hasMore set',
    );
  });

  it('fails with 413 instead of silently materializing beyond the call-site cap', async () => {
    const work = listAll(pagedQuery([[1, 2], [3]]), { maxItems: 2, label: 'Blocks' });
    await expect(work).rejects.toMatchObject({ status: 413 });
  });

  it('keeps paging past the naive maxItems/pageSize page count when pages come back short', async () => {
    // A runtime may return fewer than pageSize rows per page with hasMore
    // still true; the budget is rows read, not pages fetched.
    expect(await listAll(pagedQuery([[1], [2], [3]]), { maxItems: 3 })).toEqual([1, 2, 3]);
  });

  it('does not 413 when the budget is reached and the trailing hasMore is a false positive', async () => {
    // Exactly-full final page: hasMore=true but the probe page is empty.
    expect(await listAll(pagedQuery([[1, 2], []], false), { maxItems: 2 })).toEqual([1, 2]);
  });

  it('413s only when rows beyond the budget genuinely exist', async () => {
    await expect(listAll(pagedQuery([[1, 2], [3]]), { maxItems: 2 })).rejects.toMatchObject({
      status: 413,
    });
  });

  it('requires explicit opt-in above the safe default and enforces an absolute ceiling', async () => {
    await expect(listAll(pagedQuery([[1]]), { maxItems: DEFAULT_LIST_ALL_MAX_ITEMS + 1 }))
      .rejects.toThrow('allowLargeMaterialization: true');
    await expect(listAll(pagedQuery([[1]]), {
      maxItems: ABSOLUTE_LIST_ALL_MAX_ITEMS + 1,
      allowLargeMaterialization: true,
    })).rejects.toThrow(`cannot exceed ${ABSOLUTE_LIST_ALL_MAX_ITEMS}`);
  });
});

describe('requireString', () => {
  it('trims and returns the value', () => {
    expect(requireString('  hello ', 'name')).toBe('hello');
  });

  it('rejects empty, blank, and non-string values', () => {
    expect(() => requireString('', 'name')).toThrow('name is required.');
    expect(() => requireString('   ', 'name')).toThrow('name is required.');
    expect(() => requireString(42, 'name')).toThrow('name is required.');
    expect(() => requireString(undefined, 'name')).toThrow('name is required.');
  });
});

describe('requireStringRaw', () => {
  it('keeps surrounding whitespace', () => {
    expect(requireStringRaw('  hello ', 'text')).toBe('  hello ');
  });

  it('still rejects blank-only values', () => {
    expect(() => requireStringRaw('   ', 'text')).toThrow('text is required.');
  });
});

describe('getExisting', () => {
  it('returns the row when getOne succeeds', async () => {
    const ref = { getOne: async () => ({ id: 'a' }) };
    expect(await getExisting(ref, 'a')).toEqual({ id: 'a' });
  });

  it('returns null when getOne throws a 404 (missing record)', async () => {
    const ref = {
      getOne: async () => {
        throw Object.assign(new Error('Not found.'), { code: 404 });
      },
    };
    expect(await getExisting(ref, 'a')).toBeNull();
  });

  it('accepts the status alias for 404 detection', async () => {
    const ref = {
      getOne: async () => {
        throw Object.assign(new Error('Not found.'), { status: 404 });
      },
    };
    expect(await getExisting(ref, 'a')).toBeNull();
  });

  it('rethrows non-404 failures instead of masking them as missing rows', async () => {
    const ref = {
      getOne: async () => {
        throw Object.assign(new Error('Server error.'), { code: 500 });
      },
    };
    await expect(getExisting(ref, 'a')).rejects.toThrow('Server error.');
  });

  it('treats status-less transport record-not-found messages as missing rows', async () => {
    // The Workers runtime rethrows DB errors as plain Errors with only the
    // message; both handler variants must map to null.
    for (const message of ["Record 'abc' not found in 'pages'.", 'Record abc not found.']) {
      const ref = {
        getOne: async () => {
          throw new Error(message);
        },
      };
      expect(await getExisting(ref, 'a')).toBeNull();
    }
  });

  it('still rethrows table-level and function-level not-found errors', async () => {
    for (const message of ['Table "pages" not found in this DO.', "Function 'x' not found."]) {
      const ref = {
        getOne: async () => {
          throw new Error(message);
        },
      };
      await expect(getExisting(ref, 'a')).rejects.toThrow(message);
    }
  });

  it('rethrows plain errors with no status code', async () => {
    const ref = {
      getOne: async () => {
        throw new Error('boom');
      },
    };
    await expect(getExisting(ref, 'a')).rejects.toThrow('boom');
  });
});

describe('bestEffort', () => {
  it('returns true when the work resolves', async () => {
    expect(await bestEffort('test', Promise.resolve('ok'))).toBe(true);
  });

  it('returns false and logs when the work rejects', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await bestEffort('notify user', Promise.reject(new Error('down')))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('notify user');
    spy.mockRestore();
  });
});
