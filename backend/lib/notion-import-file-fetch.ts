import { normalizeFileContentType } from './file-security';
import { fetchPublicResource } from './ssrf-guard';

export const MAX_IMPORTED_FILE_SIZE = 5 * 1024 * 1024 * 1024;
// Responses without Content-Length must be buffered to learn their exact size
// before atomically reserving organization quota. Keep that buffer bounded far
// below the 5 GiB normal-file ceiling so a chunked source cannot exhaust the
// worker. Larger sources must provide an honest length.
export const MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE = 64 * 1024 * 1024;

interface NotionImportFetchFileReference {
  name: string;
  url: string;
  type?: string;
}

export function normalizedImportedContentType(contentType: string | null | undefined, fallback?: string) {
  return normalizeFileContentType(contentType, fallback);
}

export function sourceUrlCanBeCopied(url: string) {
  return /^https?:\/\//i.test(url) || /^data:/i.test(url);
}

export function responseContentLength(response: Response) {
  const raw = response.headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

// No Content-Length: accumulate the body with a running byte cap and abort the
// read as soon as the cap is crossed, instead of buffering the whole response
// first — an attacker-controlled chunked response must not be able to exhaust
// worker memory before the size check runs. Exported for the unit cap test.
export async function readResponseBodyWithByteCap(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Runtimes that expose no readable stream (e.g. data: URL fetches) still
    // get the post-hoc check.
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error('source file is too large');
    return buffer;
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('source file is too large').catch(() => {});
      throw new Error('source file is too large');
    }
    parts.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined.buffer;
}

// Content-Length is a claim made by the remote server. Stream through a
// counter so a malicious source cannot advertise one byte and make R2 ingest
// an unbounded body before the post-upload HEAD check notices.
export function responseBodyWithExactByteCount(
  body: ReadableStream<Uint8Array>,
  expectedBytes: number,
  maxBytes: number,
  FixedLengthStreamCtor = (
    globalThis as typeof globalThis & {
      FixedLengthStream?: new (
        length: number | bigint,
      ) => ReadableWritablePair<Uint8Array, Uint8Array>;
    }
  ).FixedLengthStream,
) {
  let total = 0;
  const validated = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) throw new Error('source file is too large');
      if (total > expectedBytes) throw new Error('source file size did not match Content-Length');
      controller.enqueue(chunk);
    },
    flush() {
      if (total !== expectedBytes) throw new Error('source file size did not match Content-Length');
    },
  }));
  // R2 rejects an ordinary ReadableStream even when the source response
  // advertised Content-Length. The validation TransformStream above strips
  // the runtime's fixed-length brand, so restore it at the storage boundary.
  // Node-based unit tests do not expose this Workers runtime primitive and use
  // the validated stream directly; unknown-length responses are buffered into
  // an ArrayBuffer before reaching this branch.
  return FixedLengthStreamCtor
    ? validated.pipeThrough(new FixedLengthStreamCtor(expectedBytes))
    : validated;
}

export async function fetchFileForImport(reference: NotionImportFetchFileReference) {
  if (!sourceUrlCanBeCopied(reference.url)) {
    throw new Error('unsupported file URL scheme');
  }
  // A Notion workspace may contain arbitrary attachment formats, including
  // SVG, HTML, XML, and source-code files. Preserve their declared MIME in
  // storage; EdgeBase is the delivery security boundary and serves every
  // non-passive type as an opaque, sandboxed attachment with nosniff. The
  // importer still validates MIME syntax, source routing, size, byte count,
  // storage integrity, ownership, and quota before committing the reference.
  normalizedImportedContentType(reference.type, 'application/octet-stream');
  // SSRF guard: `data:` URLs are inline payloads (no network fetch), but any
  // http(s) source must resolve to a public host on every redirect hop.
  // fetchPublicResource follows redirects manually and re-validates each one.
  const isHttp = /^https?:\/\//i.test(reference.url);
  const fetchInit = { signal: AbortSignal.timeout(60_000) };
  const response = isHttp
    ? await fetchPublicResource(reference.url, fetchInit)
    : await fetch(reference.url, fetchInit);
  if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
  const contentLength = responseContentLength(response);
  if (contentLength && contentLength > MAX_IMPORTED_FILE_SIZE) {
    throw new Error('source file is too large');
  }
  const contentType = normalizedImportedContentType(
    response.headers.get('content-type'),
    reference.type,
  );
  if (response.body && contentLength) {
    return {
      body: responseBodyWithExactByteCount(response.body, contentLength, MAX_IMPORTED_FILE_SIZE),
      size: contentLength,
      contentType,
    };
  }
  const buffer = await readResponseBodyWithByteCap(response, MAX_UNKNOWN_LENGTH_IMPORTED_FILE_SIZE);
  if (buffer.byteLength <= 0) throw new Error('source file was empty');
  return {
    body: buffer,
    size: buffer.byteLength,
    contentType,
  };
}

export function fileCopyFailureMessage(label: string, reference: NotionImportFetchFileReference, reason: string) {
  return `Notion import could not copy file "${reference.name}" from ${label} into EdgeBase storage: ${reason}`;
}
