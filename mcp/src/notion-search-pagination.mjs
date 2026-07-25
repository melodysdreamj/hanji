import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const CURSOR_PREFIX = "hanji-search-v1";
const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_CURSOR_BYTES = 32 * 1024;
const MAX_CURSOR_STATE_BYTES = 20 * 1024;
const MAX_SOURCE_CURSOR_BYTES = 16 * 1024;
const DEFAULT_CURSOR_SECRET = randomBytes(32);
const SEARCH_CURSOR_KINDS = new Set([
  "user",
  "data_source",
  "workspace_pages",
  "workspace_blocks",
]);

function canonicalValue(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function cursorError(message) {
  return new Error(`Search cursor ${message}`);
}

function validOpaqueString(value, maxLength = 512) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function normalizeCursorState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw cursorError("state is malformed.");
  }
  const kind = state.kind;
  if (!SEARCH_CURSOR_KINDS.has(kind)) throw cursorError("state kind is malformed.");
  if (kind === "user") {
    if (!validOpaqueString(state.upstreamCursor)) {
      throw cursorError("user continuation is malformed.");
    }
    return { kind, upstreamCursor: state.upstreamCursor };
  }
  if (!validOpaqueString(state.revision)) {
    throw cursorError("source revision is malformed.");
  }
  if (kind === "data_source") {
    if (!Number.isSafeInteger(state.offset) || state.offset < 0) {
      throw cursorError("offset is malformed.");
    }
    return {
      kind,
      offset: state.offset,
      revision: state.revision,
    };
  }
  if (
    state.sourceCursor !== null
    && !validOpaqueString(state.sourceCursor, MAX_SOURCE_CURSOR_BYTES)
  ) {
    throw cursorError("source continuation is malformed.");
  }
  const normalized = {
    kind,
    sourceCursor: state.sourceCursor,
    revision: state.revision,
  };
  return normalized;
}

function secretBytes(secret) {
  if (typeof secret === "string") {
    if (!secret) throw new Error("Search cursor secret must not be empty.");
    return Buffer.from(secret, "utf8");
  }
  if (ArrayBuffer.isView(secret)) {
    const bytes = Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength);
    if (bytes.byteLength === 0) throw new Error("Search cursor secret must not be empty.");
    return bytes;
  }
  throw new Error("Search cursor secret must be a string or byte array.");
}

function decodeBase64Url(value, label) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw cursorError(`${label} is malformed.`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw cursorError(`${label} is malformed.`);
  return bytes;
}

export function notionSearchRequestFingerprint(input) {
  return createHash("sha256").update(canonicalJson(input)).digest("base64url");
}

export function createNotionSearchCursorCodec({
  secret = DEFAULT_CURSOR_SECRET,
  now = () => Date.now(),
  ttlMs = DEFAULT_CURSOR_TTL_MS,
} = {}) {
  const key = secretBytes(secret);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("Search cursor ttlMs must be a positive safe integer.");
  }

  function encode(state, fingerprint) {
    if (!validOpaqueString(fingerprint, 128)) {
      throw cursorError("request fingerprint is malformed.");
    }
    const normalizedState = normalizeCursorState(state);
    const stateJson = canonicalJson(normalizedState);
    if (Buffer.byteLength(stateJson, "utf8") > MAX_CURSOR_STATE_BYTES) {
      throw cursorError("state is too large.");
    }
    const issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) {
      throw new Error("Search cursor clock returned an invalid timestamp.");
    }
    const payload = Buffer.from(canonicalJson({
      v: 1,
      iat: issuedAt,
      exp: issuedAt + ttlMs,
      fingerprint,
      state: normalizedState,
    }), "utf8").toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    const token = `${CURSOR_PREFIX}.${payload}.${signature}`;
    if (Buffer.byteLength(token, "utf8") > MAX_CURSOR_BYTES) {
      throw cursorError("is too large.");
    }
    return token;
  }

  function decode(token, fingerprint) {
    if (!validOpaqueString(token, MAX_CURSOR_BYTES)) throw cursorError("is malformed.");
    if (!validOpaqueString(fingerprint, 128)) {
      throw cursorError("request fingerprint is malformed.");
    }
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== CURSOR_PREFIX) {
      throw cursorError("is malformed.");
    }
    const payloadBytes = decodeBase64Url(parts[1], "payload");
    const presentedSignature = decodeBase64Url(parts[2], "signature");
    const expectedSignature = createHmac("sha256", key).update(parts[1]).digest();
    if (
      presentedSignature.byteLength !== expectedSignature.byteLength
      || !timingSafeEqual(presentedSignature, expectedSignature)
    ) {
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
    if (payload.fingerprint !== fingerprint) {
      throw cursorError("does not match this request.");
    }
    if (now() > payload.exp) throw cursorError("expired.");
    return normalizeCursorState(payload.state);
  }

  return Object.freeze({ encode, decode });
}

export const notionSearchCursorCodec = createNotionSearchCursorCodec();
