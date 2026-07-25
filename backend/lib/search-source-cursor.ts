import { hanjiEnvFlag, hanjiEnvValue } from './hanji-compat';

const CURSOR_PREFIX = 'hanji-search-source-v1';
const CURSOR_TTL_MS = 15 * 60 * 1_000;
const CURSOR_MAX_BYTES = 16 * 1_024;
const CURSOR_STATE_MAX_BYTES = 8 * 1_024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const testSecret = crypto.getRandomValues(new Uint8Array(32));

function cursorClientError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw cursorClientError('Search source cursor is malformed.');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw cursorClientError('Search source cursor is malformed.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (base64UrlEncode(bytes) !== value) {
    throw cursorClientError('Search source cursor is malformed.');
  }
  return bytes;
}

function cursorSecret(env: Record<string, unknown> | undefined) {
  const configured = hanjiEnvValue(
    env,
    'HANJI_SEARCH_CURSOR_SECRET',
    'HANJI_MCP_OAUTH_SECRET',
    'HANJI_MCP_JWT_SECRET',
    'JWT_USER_SECRET',
    'EDGEBASE_JWT_SECRET',
  );
  if (configured) return encoder.encode(configured);
  if (
    hanjiEnvValue(env, 'NODE_ENV') === 'test'
    || hanjiEnvFlag(env, 'HANJI_SEARCH_CURSOR_ALLOW_DEV_SECRET')
  ) return testSecret;
  throw new Error('HANJI_SEARCH_CURSOR_SECRET is required for paginated search.');
}

async function cursorKey(env: Record<string, unknown> | undefined) {
  const digest = await crypto.subtle.digest('SHA-256', cursorSecret(env));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encodeSearchSourceCursor(
  state: unknown,
  env: Record<string, unknown> | undefined,
) {
  const issuedAt = Date.now();
  const plaintext = encoder.encode(JSON.stringify({
    v: 1,
    iat: issuedAt,
    exp: issuedAt + CURSOR_TTL_MS,
    state,
  }));
  if (plaintext.byteLength > CURSOR_STATE_MAX_BYTES) {
    throw new Error('Search source cursor state exceeded its bounded size.');
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(CURSOR_PREFIX) },
    await cursorKey(env),
    plaintext,
  ));
  const token = `${CURSOR_PREFIX}.${base64UrlEncode(iv)}.${base64UrlEncode(ciphertext)}`;
  if (encoder.encode(token).byteLength > CURSOR_MAX_BYTES) {
    throw new Error('Search source cursor exceeded its bounded size.');
  }
  return token;
}

export async function decodeSearchSourceCursor(
  token: unknown,
  env: Record<string, unknown> | undefined,
) {
  if (
    typeof token !== 'string'
    || !token
    || encoder.encode(token).byteLength > CURSOR_MAX_BYTES
  ) throw cursorClientError('Search source cursor is malformed.');
  const [prefix, encodedIv, encodedCiphertext, extra] = token.split('.');
  if (prefix !== CURSOR_PREFIX || !encodedIv || !encodedCiphertext || extra !== undefined) {
    throw cursorClientError('Search source cursor is malformed.');
  }
  const iv = base64UrlDecode(encodedIv);
  const ciphertext = base64UrlDecode(encodedCiphertext);
  const key = await cursorKey(env);
  let plaintext: Uint8Array;
  try {
    plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: encoder.encode(CURSOR_PREFIX),
      },
      key,
      ciphertext,
    ));
  } catch {
    throw cursorClientError('Search source cursor is invalid.');
  }
  if (plaintext.byteLength > CURSOR_STATE_MAX_BYTES) {
    throw cursorClientError('Search source cursor is malformed.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(decoder.decode(plaintext)) as Record<string, unknown>;
  } catch {
    throw cursorClientError('Search source cursor is malformed.');
  }
  const now = Date.now();
  if (
    payload.v !== 1
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.exp)
    || Number(payload.iat) > now + 30_000
    || Number(payload.exp) < now
    || Number(payload.exp) - Number(payload.iat) !== CURSOR_TTL_MS
  ) throw cursorClientError('Search source cursor has expired or is malformed.');
  return payload.state;
}
