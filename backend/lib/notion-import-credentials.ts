import { hanjiCanonicalEnvValue, hanjiEnvValue } from './hanji-compat';
import { nowIso, requireString } from './table-utils';

/** OAuth state and encrypted credential ownership for the Notion importer. */
export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_API_BASE_ENV = 'HANJI_NOTION_API_BASE';
export const NOTION_OAUTH_ENABLED_ENV = 'HANJI_NOTION_OAUTH_ENABLED';
export const NOTION_OAUTH_CLIENT_ID_ENV = 'HANJI_NOTION_OAUTH_CLIENT_ID';
export const NOTION_OAUTH_CLIENT_SECRET_ENV = 'HANJI_NOTION_OAUTH_CLIENT_SECRET';
export const NOTION_OAUTH_AUTH_URL_ENV = 'HANJI_NOTION_OAUTH_AUTH_URL';
export const NOTION_OAUTH_REDIRECT_URI_ENV = 'HANJI_NOTION_OAUTH_REDIRECT_URI';
export const NOTION_OAUTH_STATE_SECRET_ENV = 'HANJI_NOTION_OAUTH_STATE_SECRET';
export const NOTION_CONNECTION_SECRET_ENV = 'HANJI_NOTION_IMPORT_SECRET';
export const LEGACY_NOTION_CONNECTION_SECRET_ENV = 'NOTION_IMPORT_SECRET';
export const NOTION_CREDENTIAL_ALGORITHM = 'AES-GCM-SHA256';
export const NOTION_CREDENTIAL_KEY_ID = 'notion-import-v1';
export const NOTION_OAUTH_STATE_MAX_AGE_MS = 15 * 60 * 1000;

export interface NotionOAuthStatePayload {
  workspaceId: string;
  actorId: string;
  redirectUri: string;
  name?: string;
  nonce: string;
  createdAt: string;
}

interface NotionStoredOAuthCredential {
  kind: 'oauth';
  accessToken: string;
  refreshToken?: string | null;
  tokenType?: string | null;
  issuedAt: string;
  refreshedAt?: string | null;
}

export type DecryptedNotionCredential =
  | { kind: 'token'; token: string }
  | { kind: 'oauth'; accessToken: string; refreshToken?: string | null; tokenType?: string | null };

interface NotionCredentialConnection {
  connectionKind: string;
  credentialCiphertext?: string | null;
}

function optionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function envString(env: Record<string, unknown> | undefined, key: string) {
  return hanjiEnvValue(env, key);
}

export function notionOAuthEnabled(env: Record<string, unknown> | undefined) {
  return hanjiCanonicalEnvValue(env, NOTION_OAUTH_ENABLED_ENV) === 'true';
}

export function assertNotionOAuthEnabled(env: Record<string, unknown> | undefined) {
  if (notionOAuthEnabled(env)) return;
  throw new Error(`${NOTION_OAUTH_ENABLED_ENV}=true is required for Notion OAuth.`);
}

export function notionApiBase(env: Record<string, unknown> | undefined) {
  return (envString(env, NOTION_API_BASE_ENV) ?? NOTION_API_BASE).replace(/\/+$/, '');
}

export function notionOAuthAuthorizeUrl(env: Record<string, unknown> | undefined) {
  assertNotionOAuthEnabled(env);
  return (
    envString(env, NOTION_OAUTH_AUTH_URL_ENV) ??
    `${notionApiBase(env)}/oauth/authorize`
  ).trim();
}

export function notionOAuthClientId(env: Record<string, unknown> | undefined) {
  assertNotionOAuthEnabled(env);
  const clientId = envString(env, NOTION_OAUTH_CLIENT_ID_ENV);
  if (!clientId) throw new Error(`${NOTION_OAUTH_CLIENT_ID_ENV} is required for Notion OAuth.`);
  return clientId;
}

export function notionOAuthClientSecret(env: Record<string, unknown> | undefined) {
  assertNotionOAuthEnabled(env);
  const clientSecret = envString(env, NOTION_OAUTH_CLIENT_SECRET_ENV);
  if (!clientSecret) throw new Error(`${NOTION_OAUTH_CLIENT_SECRET_ENV} is required for Notion OAuth.`);
  return clientSecret;
}

export function notionOAuthRedirectUri(
  env: Record<string, unknown> | undefined,
  body: Record<string, unknown>,
) {
  assertNotionOAuthEnabled(env);
  const configured = envString(env, NOTION_OAUTH_REDIRECT_URI_ENV);
  const requested = optionalString(body.redirectUri);
  if (configured) {
    if (requested && requested !== configured) {
      throw new Error(
        `redirectUri must exactly match ${NOTION_OAUTH_REDIRECT_URI_ENV}.`,
      );
    }
    return configured;
  }
  if (requested) return requested;
  throw new Error('redirectUri is required for Notion OAuth.');
}

export function notionCredentialSecret(env: Record<string, unknown> | undefined) {
  return (
    envString(env, NOTION_CONNECTION_SECRET_ENV) ??
    envString(env, LEGACY_NOTION_CONNECTION_SECRET_ENV)
  );
}

export function notionConnectionStorageAvailable(env: Record<string, unknown> | undefined) {
  return notionCredentialSecret(env) !== undefined;
}

export function notionOAuthStateSecret(env: Record<string, unknown> | undefined) {
  assertNotionOAuthEnabled(env);
  return (
    envString(env, NOTION_OAUTH_STATE_SECRET_ENV) ??
    notionCredentialSecret(env) ??
    notionOAuthClientSecret(env)
  );
}

export function base64UrlEncode(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

export function base64EncodeText(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function hmacSha256(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

export async function encodeNotionOAuthState(
  payload: NotionOAuthStatePayload,
  env: Record<string, unknown> | undefined,
) {
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = base64UrlEncode(await hmacSha256(notionOAuthStateSecret(env), encodedPayload));
  return `${encodedPayload}.${signature}`;
}

export async function decodeNotionOAuthState(
  state: string,
  env: Record<string, unknown> | undefined,
): Promise<NotionOAuthStatePayload> {
  const [encodedPayload, encodedSignature, extra] = state.split('.');
  if (!encodedPayload || !encodedSignature || extra !== undefined) {
    throw new Error('Notion OAuth state is invalid.');
  }
  const expected = await hmacSha256(notionOAuthStateSecret(env), encodedPayload);
  const actual = base64UrlDecode(encodedSignature);
  if (!bytesEqual(expected, actual)) throw new Error('Notion OAuth state is invalid.');
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as Record<string, unknown>;
  } catch {
    throw new Error('Notion OAuth state is invalid.');
  }
  const workspaceId = requireString(payload.workspaceId, 'workspaceId');
  const actorId = requireString(payload.actorId, 'actorId');
  const redirectUri = requireString(payload.redirectUri, 'redirectUri');
  const nonce = requireString(payload.nonce, 'nonce');
  const createdAt = requireString(payload.createdAt, 'createdAt');
  const createdTime = new Date(createdAt).getTime();
  if (!Number.isFinite(createdTime) || Date.now() - createdTime > NOTION_OAUTH_STATE_MAX_AGE_MS) {
    throw new Error('Notion OAuth state has expired.');
  }
  return {
    workspaceId,
    actorId,
    redirectUri,
    name: optionalString(payload.name),
    nonce,
    createdAt,
  };
}

export async function credentialCryptoKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptNotionCredential(token: string, env: Record<string, unknown> | undefined) {
  const secret = notionCredentialSecret(env);
  if (!secret) {
    throw new Error(`${NOTION_CONNECTION_SECRET_ENV} is required to store Notion import connections.`);
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialCryptoKey(secret);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(token),
  );
  return JSON.stringify({
    v: 1,
    alg: NOTION_CREDENTIAL_ALGORITHM,
    kid: NOTION_CREDENTIAL_KEY_ID,
    iv: base64UrlEncode(iv),
    data: base64UrlEncode(new Uint8Array(encrypted)),
  });
}

export async function encryptNotionOAuthCredential(
  input: {
    accessToken: string;
    refreshToken?: string | null;
    tokenType?: string | null;
    refreshedAt?: string | null;
  },
  env: Record<string, unknown> | undefined,
) {
  assertNotionOAuthEnabled(env);
  const payload: NotionStoredOAuthCredential = {
    kind: 'oauth',
    accessToken: input.accessToken,
    refreshToken: input.refreshToken ?? null,
    tokenType: input.tokenType ?? 'bearer',
    issuedAt: nowIso(),
    refreshedAt: input.refreshedAt ?? null,
  };
  return encryptNotionCredential(JSON.stringify(payload), env);
}

export async function decryptNotionCredential(
  connection: NotionCredentialConnection,
  env: Record<string, unknown> | undefined,
): Promise<DecryptedNotionCredential> {
  const secret = notionCredentialSecret(env);
  if (!secret) {
    throw new Error(`${NOTION_CONNECTION_SECRET_ENV} is required to use stored Notion import connections.`);
  }
  if (!connection.credentialCiphertext) {
    throw new Error('Notion import connection has no stored credential.');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(connection.credentialCiphertext) as Record<string, unknown>;
  } catch {
    throw new Error('Notion import connection credential is invalid.');
  }
  if (payload.alg !== NOTION_CREDENTIAL_ALGORITHM || payload.kid !== NOTION_CREDENTIAL_KEY_ID) {
    throw new Error('Notion import connection credential uses an unsupported format.');
  }
  const iv = typeof payload.iv === 'string' ? base64UrlDecode(payload.iv) : undefined;
  const data = typeof payload.data === 'string' ? base64UrlDecode(payload.data) : undefined;
  if (!iv || !data) throw new Error('Notion import connection credential is incomplete.');
  const key = await credentialCryptoKey(secret);
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    const plaintext = new TextDecoder().decode(decrypted);
    try {
      const parsed = JSON.parse(plaintext) as Partial<NotionStoredOAuthCredential>;
      if (parsed?.kind === 'oauth' && typeof parsed.accessToken === 'string' && parsed.accessToken.trim()) {
        return {
          kind: 'oauth',
          accessToken: parsed.accessToken.trim(),
          refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken.trim()
            ? parsed.refreshToken.trim()
            : null,
          tokenType: typeof parsed.tokenType === 'string' && parsed.tokenType.trim()
            ? parsed.tokenType.trim()
            : 'bearer',
        };
      }
    } catch {
      // Existing stored connections encrypted the raw token directly.
    }
    return { kind: 'token', token: plaintext };
  } catch {
    throw new Error('Notion import connection credential could not be decrypted.');
  }
}
