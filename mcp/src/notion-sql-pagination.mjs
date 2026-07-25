import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const CURSOR_PREFIX = "hanji-sql-v1";
const CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_CURSOR_BYTES = 32 * 1024;
const MAX_SOURCE_CURSOR_BYTES = 16 * 1024;
const DEFAULT_SECRET = randomBytes(32);

function canonicalValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function cursorError(message) {
  return new Error(`SQL cursor ${message}`);
}

function validString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function normalizeState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw cursorError("state is malformed.");
  }
  if (
    state.sourceCursor !== null
    && !validString(state.sourceCursor, MAX_SOURCE_CURSOR_BYTES)
  ) throw cursorError("source continuation is malformed.");
  if (!Number.isSafeInteger(state.remainingOffset) || state.remainingOffset < 0) {
    throw cursorError("remaining offset is malformed.");
  }
  return {
    sourceCursor: state.sourceCursor,
    remainingOffset: state.remainingOffset,
  };
}

function decodeBase64Url(value, label) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw cursorError(`${label} is malformed.`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw cursorError(`${label} is malformed.`);
  return bytes;
}

export function notionSqlRequestFingerprint(input) {
  return createHash("sha256").update(canonicalJson(input)).digest("base64url");
}

export function createNotionSqlCursorCodec({
  secret = DEFAULT_SECRET,
  now = () => Date.now(),
  ttlMs = CURSOR_TTL_MS,
} = {}) {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (key.byteLength === 0) throw new Error("SQL cursor secret must not be empty.");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("SQL cursor ttlMs must be a positive safe integer.");
  }

  function encode(state, fingerprint) {
    if (!validString(fingerprint, 128)) throw cursorError("request fingerprint is malformed.");
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("SQL cursor clock returned an invalid timestamp.");
    }
    const payload = Buffer.from(canonicalJson({
      v: 1,
      iat: issuedAt,
      exp: issuedAt + ttlMs,
      fingerprint,
      state: normalizeState(state),
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    const token = `${CURSOR_PREFIX}.${payload}.${signature}`;
    if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) throw cursorError("is too large.");
    return token;
  }

  function decode(token, fingerprint) {
    if (!validString(token, MAX_CURSOR_BYTES)) throw cursorError("is malformed.");
    if (!validString(fingerprint, 128)) throw cursorError("request fingerprint is malformed.");
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) throw cursorError("is malformed.");
    const payloadBytes = decodeBase64Url(parts[1], "payload");
    const signature = decodeBase64Url(parts[2], "signature");
    const expected = createHmac("sha256", key).update(parts[1]).digest();
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
      throw cursorError("signature is invalid.");
    }
    let payload;
    try {
      payload = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw cursorError("payload is malformed.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload.v !== 1) {
      throw cursorError("payload is malformed.");
    }
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) {
      throw cursorError("lifetime is malformed.");
    }
    if (payload.fingerprint !== fingerprint) throw cursorError("does not match this request.");
    if (now() > payload.exp) throw cursorError("expired.");
    return normalizeState(payload.state);
  }

  return Object.freeze({ encode, decode });
}

export const notionSqlCursorCodec = createNotionSqlCursorCodec();
