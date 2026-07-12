import { describe, expect, it, vi } from 'vitest';
import { errorStatus, STANDARD_ERROR_STATUS_RULES } from '../../lib/error-status';

describe('errorStatus', () => {
  it('maps the standard handler phrases with the standard rules', () => {
    expect(errorStatus(new Error('Page edit access required.')).status).toBe(403);
    expect(errorStatus(new Error('Page is locked.')).status).toBe(423);
    expect(errorStatus(new Error('Page was not found.')).status).toBe(404);
    expect(errorStatus(new Error('title must be a string.')).status).toBe(400);
    expect(errorStatus(new Error('Invalid rollup function.'))).toEqual({
      status: 400,
      message: 'Invalid rollup function.',
    });
    for (const message of [
      'Formula prop() requires a quoted property name or id.',
      'Formula string literal is not closed.',
      'Formula parentheses are not balanced.',
      'Property 2 needs a name.',
      'Database record row-1 appears more than once.',
      'A database can only have one title property.',
      'Duplicate database property name: Status.',
      'Workspace invitation is not pending.',
      'Workspace invitation has expired.',
    ]) {
      expect(errorStatus(new Error(message))).toEqual({ status: 400, message });
    }
  });

  it('maps every validate.ts phrasing to 400 (a schema rejection must never 500-retry-loop)', () => {
    // Exact messages thrown by lib/validate.ts combinators; 'must serialize'
    // (jsonRecord byte ceiling) previously matched no needle and fell through
    // to the 500 fallback, so oversized block content retried forever.
    for (const message of [
      'content must serialize to at most 262144 bytes.',
      'title must be a string.',
      'id is required.',
      'name must be at least 1 characters.',
      'title must be at most 4096 characters.',
      'id contains invalid characters.',
      'fullWidth must be a boolean.',
      'position must be a number.',
      'position must be an integer.',
      'coverPosition must be >= 0.',
      'coverPosition must be <= 100.',
      'parentType must be one of: workspace, page, database.',
      'body must be an object.',
      'blocks must be an array.',
      'blocks must have at most 10000 items.',
    ]) {
      expect(errorStatus(new Error(message))).toEqual({ status: 400, message });
    }
  });

  it('returns the thrown message unchanged', () => {
    const { message } = errorStatus(new Error('Workspace edit access required.'));
    expect(message).toBe('Workspace edit access required.');
  });

  it('stringifies non-Error values and fails unexpected errors as 500', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorStatus('boom')).toEqual({ status: 500, message: 'Internal server error.' });
    expect(errorStatus(undefined)).toEqual({ status: 500, message: 'Internal server error.' });
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('preserves an explicit HTTP status carried by infrastructure errors', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorStatus(Object.assign(new Error('conflict'), { code: 409 })).status).toBe(409);
    expect(errorStatus(Object.assign(new Error('unavailable'), { status: 503 }))).toEqual({
      status: 503,
      message: 'Internal server error.',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('evaluates rules in order so handler-specific precedence is preserved', () => {
    const blockRules = [
      { status: 403, needles: ['access required'] },
      { status: 423, needles: ['locked'] },
      { status: 409, needles: ['changed since'] },
      { status: 404, needles: ['not found'] },
    ];
    expect(errorStatus(new Error('Block changed since last read and was not found.'), blockRules).status).toBe(409);

    const rowRules = [
      { status: 423, needles: ['locked'] },
      { status: 403, needles: ['access required', 'outside the row workspace'] },
      { status: 404, needles: ['not found'] },
    ];
    expect(errorStatus(new Error('Row page is locked; edit access required.'), rowRules).status).toBe(423);
    expect(errorStatus(new Error('Relation target is outside the row workspace.'), rowRules).status).toBe(403);

    const workspaceRules = [
      { status: 400, needles: ['Disable domain-restricted signup'] },
    ];
    expect(errorStatus(
      new Error('Disable domain-restricted signup before removing the last verified domain.'),
      workspaceRules,
    ).status).toBe(400);
  });

  it('matches any needle within a rule', () => {
    const rules = [{ status: 404, needles: ['not found', 'trash', 'not a database'] }];
    expect(errorStatus(new Error('Page is in trash.'), rules).status).toBe(404);
    expect(errorStatus(new Error('Target page is not a database.'), rules).status).toBe(404);
  });

  it('supports a custom fallback status', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(errorStatus(new Error('anything'), STANDARD_ERROR_STATUS_RULES, 500)).toEqual({
      status: 500,
      message: 'Internal server error.',
    });
    spy.mockRestore();
  });
});
