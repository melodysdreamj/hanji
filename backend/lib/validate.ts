// Lightweight request-body schema validation for function entry points.
//
// Zod-style combinators without adding a dependency to the edge bundle.
// Validation errors throw plain Error (message ends with a field path) so the
// existing per-function catch blocks map them to HTTP 400 unchanged.
//
// Entry schemas are deliberately permissive about unknown fields: `object`
// checks only the declared keys and passes the rest through untouched, so a
// newer client sending extra fields does not break an older server.

export interface Schema<T> {
  parse(value: unknown, path?: string): T;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;

const MAX_ID_LENGTH = 128;
const MAX_SHORT_TEXT_LENGTH = 4_096;
const MAX_LONG_TEXT_LENGTH = 262_144; // 256 KB — block/comment rich content ceiling
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

function fail(path: string, message: string): never {
  throw new Error(`${path} ${message}`);
}

interface StringOptions {
  min?: number;
  max?: number;
  trim?: boolean;
}

function string(options: StringOptions = {}): Schema<string> {
  const { min = 0, max = MAX_SHORT_TEXT_LENGTH, trim = false } = options;
  return {
    parse(value, path = 'value') {
      if (typeof value !== 'string') fail(path, 'must be a string.');
      const out = trim ? value.trim() : value;
      if (out.length < min) {
        fail(path, min === 1 ? 'is required.' : `must be at least ${min} characters.`);
      }
      if (out.length > max) fail(path, `must be at most ${max} characters.`);
      return out;
    },
  };
}

// Record ids are opaque strings (EdgeBase uuids, imported ids, fixtures) —
// bound length and reject control characters instead of forcing one format.
function id(): Schema<string> {
  return {
    parse(value, path = 'id') {
      if (typeof value !== 'string' || value.trim().length === 0) fail(path, 'is required.');
      if (value.length > MAX_ID_LENGTH) fail(path, `must be at most ${MAX_ID_LENGTH} characters.`);
      if (CONTROL_CHARS_RE.test(value)) fail(path, 'contains invalid characters.');
      return value;
    },
  };
}

function shortText(options: StringOptions = {}): Schema<string> {
  return string({ max: MAX_SHORT_TEXT_LENGTH, ...options });
}

function longText(options: StringOptions = {}): Schema<string> {
  return string({ max: MAX_LONG_TEXT_LENGTH, ...options });
}

function boolean(): Schema<boolean> {
  return {
    parse(value, path = 'value') {
      if (typeof value !== 'boolean') fail(path, 'must be a boolean.');
      return value;
    },
  };
}

interface NumberOptions {
  min?: number;
  max?: number;
  int?: boolean;
}

function number(options: NumberOptions = {}): Schema<number> {
  return {
    parse(value, path = 'value') {
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a number.');
      if (options.int && !Number.isInteger(value)) fail(path, 'must be an integer.');
      if (options.min !== undefined && value < options.min) fail(path, `must be >= ${options.min}.`);
      if (options.max !== undefined && value > options.max) fail(path, `must be <= ${options.max}.`);
      return value;
    },
  };
}

function oneOf<const T extends readonly string[]>(values: T): Schema<T[number]> {
  const allowed = new Set<string>(values);
  return {
    parse(value, path = 'value') {
      if (typeof value !== 'string' || !allowed.has(value)) {
        fail(path, `must be one of: ${values.join(', ')}.`);
      }
      return value as T[number];
    },
  };
}

// JSON payload columns (block content, page properties, view config, …).
// Bounds the serialized size; the shape stays app-defined.
function jsonRecord(maxBytes = MAX_LONG_TEXT_LENGTH): Schema<Record<string, unknown>> {
  return {
    parse(value, path = 'value') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, 'must be an object.');
      }
      const size = JSON.stringify(value)?.length ?? 0;
      if (size > maxBytes) fail(path, `must serialize to at most ${maxBytes} bytes.`);
      return value as Record<string, unknown>;
    },
  };
}

function array<T>(item: Schema<T>, options: { max?: number } = {}): Schema<T[]> {
  const max = options.max ?? 10_000;
  return {
    parse(value, path = 'value') {
      if (!Array.isArray(value)) fail(path, 'must be an array.');
      if (value.length > max) fail(path, `must have at most ${max} items.`);
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
  };
}

function optional<T>(schema: Schema<T>): Schema<T | undefined> {
  return {
    parse(value, path = 'value') {
      if (value === undefined) return undefined;
      return schema.parse(value, path);
    },
  };
}

function nullish<T>(schema: Schema<T>): Schema<T | null | undefined> {
  return {
    parse(value, path = 'value') {
      if (value === undefined) return undefined;
      if (value === null) return null;
      return schema.parse(value, path);
    },
  };
}

type ObjectShape = Record<string, Schema<unknown>>;

type ObjectOutput<S extends ObjectShape> = { [K in keyof S]: Infer<S[K]> } & Record<
  string,
  unknown
>;

// Validates declared keys and passes undeclared keys through unchanged.
function object<S extends ObjectShape>(shape: S): Schema<ObjectOutput<S>> {
  return {
    parse(value, path = 'body') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(path, 'must be an object.');
      }
      const input = value as Record<string, unknown>;
      const out: Record<string, unknown> = { ...input };
      for (const key of Object.keys(shape)) {
        const parsed = shape[key].parse(input[key], key);
        if (parsed === undefined && !(key in input)) continue;
        out[key] = parsed;
      }
      return out as ObjectOutput<S>;
    },
  };
}

export const v = {
  array,
  boolean,
  id,
  jsonRecord,
  longText,
  nullish,
  number,
  object,
  oneOf,
  optional,
  shortText,
  string,
};

export const limits = {
  MAX_ID_LENGTH,
  MAX_SHORT_TEXT_LENGTH,
  MAX_LONG_TEXT_LENGTH,
};
