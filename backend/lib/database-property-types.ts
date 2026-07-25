/** Canonical Hanji database property types, including Notion 2026-03-11. */
export const DATABASE_PROPERTY_TYPES = [
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'files',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'relation',
  'rollup',
  'formula',
  'unique_id',
  'button',
  'location',
  'verification',
  'last_visited_time',
  'place',
] as const;

export type DatabasePropertyType = (typeof DATABASE_PROPERTY_TYPES)[number];

export const NOTION_2026_DATABASE_PROPERTY_TYPES = [
  'button',
  'location',
  'verification',
  'last_visited_time',
  'place',
] as const satisfies readonly DatabasePropertyType[];

/**
 * Row values for these types are produced by the product/runtime. `title` is
 * also updated through the row's title field rather than its properties map.
 */
export const READ_ONLY_DATABASE_PROPERTY_TYPES = [
  'title',
  'created_time',
  'last_edited_time',
  'created_by',
  'last_edited_by',
  'rollup',
  'formula',
  'unique_id',
  'button',
  'location',
  'last_visited_time',
] as const satisfies readonly DatabasePropertyType[];

/** No official page-value response exists for these imported schema types. */
export const OMIT_DATABASE_PROPERTY_IMPORT_VALUE = Symbol(
  'omit-database-property-import-value',
);

export interface PlacePropertyValue {
  lat: number;
  lon: number;
  name?: string | null;
  address?: string | null;
  aws_place_id?: string | null;
  google_place_id?: string | null;
}

export interface VerificationDateValue {
  start: string;
  end?: string | null;
  time_zone?: string | null;
}

export type VerificationPropertyWriteValue =
  { state: 'unverified' } | { state: 'verified'; date?: VerificationDateValue };

/** Response/import storage can additionally contain Notion's expired state. */
export type VerificationPropertyValue =
  | { state: 'unverified'; date?: null; verified_by?: null }
  | {
      state: 'verified' | 'expired';
      date?: VerificationDateValue | null;
      verified_by?: unknown;
    };

const propertyTypeSet = new Set<string>(DATABASE_PROPERTY_TYPES);
const readOnlyPropertyTypeSet = new Set<string>(
  READ_ONLY_DATABASE_PROPERTY_TYPES,
);
const placeKeys = new Set([
  'lat',
  'lon',
  'name',
  'address',
  'aws_place_id',
  'google_place_id',
]);
const verificationKeys = new Set(['state', 'date']);
const verificationImportKeys = new Set(['state', 'date', 'verified_by']);
const verificationDateKeys = new Set(['start', 'end', 'time_zone']);

function validationError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  keys: Set<string>,
  label: string,
) {
  const unsupported = Object.keys(record).find((key) => !keys.has(key));
  if (unsupported)
    throw validationError(
      `${label} contains unsupported field: ${unsupported}.`,
    );
}

function optionalNullableString(
  record: Record<string, unknown>,
  key: string,
  label: string,
) {
  if (!(key in record)) return undefined;
  const value = record[key];
  if (value !== null && typeof value !== 'string') {
    throw validationError(`${label}.${key} must be a string or null.`);
  }
  return value as string | null;
}

function isoDate(value: unknown, label: string) {
  if (typeof value !== 'string')
    throw validationError(`${label} must be an ISO date string.`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw validationError(`${label} must be an ISO date string.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw validationError(`${label} must be a valid ISO date.`);
  }
  return value;
}

export function isDatabasePropertyType(
  value: unknown,
): value is DatabasePropertyType {
  return typeof value === 'string' && propertyTypeSet.has(value);
}

export function isReadOnlyDatabasePropertyType(value: unknown) {
  return typeof value === 'string' && readOnlyPropertyTypeSet.has(value);
}

export function normalizePlacePropertyWriteValue(
  value: unknown,
): PlacePropertyValue | null {
  if (value === null) return null;
  const record = recordValue(value, 'place');
  assertOnlyKeys(record, placeKeys, 'place');
  if (typeof record.lat !== 'number' || !Number.isFinite(record.lat)) {
    throw validationError('place.lat must be a finite number.');
  }
  if (typeof record.lon !== 'number' || !Number.isFinite(record.lon)) {
    throw validationError('place.lon must be a finite number.');
  }
  const name = optionalNullableString(record, 'name', 'place');
  const address = optionalNullableString(record, 'address', 'place');
  const awsPlaceId = optionalNullableString(record, 'aws_place_id', 'place');
  const googlePlaceId = optionalNullableString(
    record,
    'google_place_id',
    'place',
  );
  return {
    lat: record.lat,
    lon: record.lon,
    ...(name !== undefined ? { name } : {}),
    ...(address !== undefined ? { address } : {}),
    ...(awsPlaceId !== undefined ? { aws_place_id: awsPlaceId } : {}),
    ...(googlePlaceId !== undefined ? { google_place_id: googlePlaceId } : {}),
  };
}

function normalizeVerificationDate(value: unknown): VerificationDateValue {
  const record = recordValue(value, 'verification.date');
  assertOnlyKeys(record, verificationDateKeys, 'verification.date');
  const start = isoDate(record.start, 'verification.date.start');
  const end = optionalNullableString(record, 'end', 'verification.date');
  if (typeof end === 'string') isoDate(end, 'verification.date.end');
  const timeZone = optionalNullableString(
    record,
    'time_zone',
    'verification.date',
  );
  return {
    start,
    ...(end !== undefined ? { end } : {}),
    ...(timeZone !== undefined ? { time_zone: timeZone } : {}),
  };
}

export function normalizeVerificationPropertyWriteValue(
  value: unknown,
): VerificationPropertyWriteValue {
  const record = recordValue(value, 'verification');
  assertOnlyKeys(record, verificationKeys, 'verification');
  if (record.state === 'unverified') {
    if ('date' in record) {
      throw validationError(
        'verification.date is only allowed when state is verified.',
      );
    }
    return { state: 'unverified' };
  }
  if (record.state !== 'verified') {
    throw validationError('verification.state must be verified or unverified.');
  }
  return {
    state: 'verified',
    ...('date' in record
      ? { date: normalizeVerificationDate(record.date) }
      : {}),
  };
}

/**
 * Validates a Notion response/import value without collapsing response-only
 * state. Unlike a writable page-property request, an imported verification
 * may be null, expired, and carry the user who verified it.
 */
export function normalizeVerificationPropertyImportValue(
  value: unknown,
): VerificationPropertyValue | null {
  if (value === null) return null;
  const record = recordValue(value, 'verification');
  assertOnlyKeys(record, verificationImportKeys, 'verification');

  if (record.state === 'unverified') {
    if ('date' in record && record.date !== null) {
      throw validationError(
        'verification.date must be null when state is unverified.',
      );
    }
    if ('verified_by' in record && record.verified_by !== null) {
      throw validationError(
        'verification.verified_by must be null when state is unverified.',
      );
    }
    return {
      state: 'unverified',
      ...('date' in record ? { date: null } : {}),
      ...('verified_by' in record ? { verified_by: null } : {}),
    };
  }

  if (record.state !== 'verified' && record.state !== 'expired') {
    throw validationError(
      'verification.state must be verified, expired, or unverified.',
    );
  }
  const date = !('date' in record)
    ? undefined
    : record.date === null
      ? null
      : normalizeVerificationDate(record.date);
  const verifiedBy = !('verified_by' in record)
    ? undefined
    : record.verified_by;
  if (verifiedBy !== undefined && verifiedBy !== null) {
    recordValue(verifiedBy, 'verification.verified_by');
  }
  return {
    state: record.state,
    ...(date !== undefined ? { date } : {}),
    ...(verifiedBy !== undefined ? { verified_by: verifiedBy } : {}),
  };
}

/**
 * Canonicalizes values arriving from Notion imports. The three read-only
 * additions deliberately do not share writable semantics: button has the
 * official empty-object value, while location and last-visited-time are
 * schema-only in the 2026-03-11 page-property response union.
 */
export function normalizeDatabasePropertyImportValue(
  type: DatabasePropertyType,
  value: unknown,
) {
  if (type === 'button') return {};
  if (type === 'location' || type === 'last_visited_time') {
    return OMIT_DATABASE_PROPERTY_IMPORT_VALUE;
  }
  if (type === 'place') return normalizePlacePropertyWriteValue(value);
  if (type === 'verification') {
    return normalizeVerificationPropertyImportValue(value);
  }
  return value;
}

/** Validates the value-bearing types added by the 2026-03-11 schema. */
export function normalizeDatabasePropertyWriteValue(
  type: DatabasePropertyType,
  value: unknown,
): unknown {
  if (isReadOnlyDatabasePropertyType(type)) {
    throw validationError(
      `Cannot write read-only database property type: ${type}.`,
    );
  }
  if (type === 'place') return normalizePlacePropertyWriteValue(value);
  if (type === 'verification')
    return normalizeVerificationPropertyWriteValue(value);
  return value;
}
