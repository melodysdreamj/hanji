// Shared error-message -> HTTP status mapping for product function handlers.
//
// Handlers in backend/functions throw plain Errors whose messages follow
// stable phrasing conventions ("... access required.", "... not found.",
// "... is locked."). Each handler's top-level catch maps those phrases to a
// status. Rules are evaluated in order; the first rule whose needle appears
// in the message wins, so handler-specific rules (409 conflicts, extra 403
// phrases) can be inserted at the position that preserves their behavior.

export interface ErrorStatusRule {
  status: number;
  needles: string[];
}

export const STANDARD_ERROR_STATUS_RULES: ErrorStatusRule[] = [
  { status: 403, needles: ['access required'] },
  { status: 423, needles: [' is locked'] },
  { status: 404, needles: ['not found'] },
  {
    status: 400,
    needles: [
      ' is required',
      ' are required',
      ' must be',
      ' must have',
      ' must include',
      ' must serialize',
      ' requires ',
      ' needs ',
      ' is invalid',
      ' contains invalid',
      ' is not closed',
      ' are not balanced',
      ' appears more than once',
      ' can only ',
      // Uppercase product prefixes stay deliberately narrow. Bare `Invalid `
      // and `Cannot ` also match JavaScript engine failures and must not turn
      // backend bugs into terminal client errors.
      'Invalid Hanji export',
      'Invalid relation target',
      'Invalid rollup function',
      'Duplicate ',
      ' cannot ',
      'Cannot add a second title property',
      'Cannot delete the title property',
      'Cannot alter the title property type',
      'Cannot move a page inside itself or one of its descendants',
      'Cannot append discovery items',
      'Cannot rediscover a Notion import graph after apply has started',
      'Cannot duplicate a page inside itself or one of its descendants',
      'Cannot change read-only database property',
      'Cannot move a row relative to itself',
      'Cannot write read-only database property type',
      'Unknown ',
      'Unsupported ',
      'unsupported ',
      'Only ',
      ' does not belong',
      ' does not match',
      ' is not pending',
      ' has expired',
      ' is not a database',
      ' is in trash',
      ' could not be merged',
      'blocked by organization DLP policy',
      'requires an organization',
      'should omit',
      'Type the workspace name',
      'Transfer workspace ownership',
      'prevents permanent deletion',
    ],
  },
];

export function errorStatus(
  error: unknown,
  rules: ErrorStatusRule[] = STANDARD_ERROR_STATUS_RULES,
  fallback = 500,
): { status: number; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const result = (
    status: number,
    inferred?: { source: 'message-rule' | 'fallback'; needle?: string },
  ) => {
    if (status >= 500) {
      console.error('[function-error] internal failure:', error);
      return { status, message: 'Internal server error.' };
    }
    if (inferred) {
      console.warn('[function-error] inferred non-500 status from message fallback:', {
        status,
        source: inferred.source,
        ...(inferred.needle ? { needle: inferred.needle } : {}),
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
    return { status, message };
  };
  // Built-in engine exceptions are backend defects, not user validation. Keep
  // them on the generic logged 500 path even if a caller supplies a custom
  // message rule that would otherwise match their text.
  if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
    return result(500);
  }
  const explicitStatus = error && typeof error === 'object'
    ? Number((error as { status?: unknown; code?: unknown }).status
      ?? (error as { status?: unknown; code?: unknown }).code)
    : NaN;
  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
    return result(explicitStatus);
  }
  const effectiveRules = rules === STANDARD_ERROR_STATUS_RULES
    ? rules
    : [...rules, ...STANDARD_ERROR_STATUS_RULES];
  for (const rule of effectiveRules) {
    const needle = rule.needles.find((candidate) => message.includes(candidate));
    if (needle) {
      return result(rule.status, { source: 'message-rule', needle });
    }
  }
  return result(fallback, { source: 'fallback' });
}
