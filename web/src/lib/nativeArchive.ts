import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const NATIVE_ARCHIVE_FORMAT = "hanji.archive" as const;
export const NATIVE_ARCHIVE_FORMAT_VERSION = 1;
export const NATIVE_ARCHIVE_DOCUMENT_PATH = "hanji/document.json";
export const NATIVE_ARCHIVE_MANIFEST_PATH = "hanji/manifest.json";
export const NATIVE_ARCHIVE_MIME = "application/vnd.hanji.archive+zip";

export const NATIVE_ARCHIVE_LIMITS = Object.freeze({
  maxFiles: 100,
  maxFileBytes: 128 * 1024 * 1024,
  maxTotalFileBytes: 512 * 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxManifestBytes: 64 * 1024,
  maxArchiveBytes: 518 * 1024 * 1024,
  maxEntries: 102,
  maxPathBytes: 240,
  maxPathDepth: 3,
  heavyConcurrency: 3,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256_HEX = /^[0-9a-f]{64}$/;
const FILE_ID = /^file-\d{6}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const FILE_MARKER_PREFIX = "hanji-archive://files/";

export interface NativeArchiveDocument {
  format: typeof NATIVE_ARCHIVE_FORMAT;
  formatVersion: number;
  generatedAt: string;
  scope: { kind: "workspace" | "subtree"; rootIds: string[] };
  source: { workspaceId: string; workspaceName?: string; workspaceIcon?: string };
  counts: Record<string, number>;
  files: { included: true; count: number; strippedReferences: number };
  entities: {
    pages: unknown[];
    blocks: unknown[];
    dbProperties: unknown[];
    dbViews: unknown[];
    dbTemplates: unknown[];
    comments: unknown[];
  };
  relationPairs: unknown[];
  warnings: Array<{ code: string; entityId?: string; detail?: string }>;
}

export interface NativeArchiveManifestFile {
  id: string;
  path: string;
  name: string;
  contentType: string;
  scope: string;
  bytes: number;
  sha256: string;
}

export interface NativeArchiveManifest {
  format: typeof NATIVE_ARCHIVE_FORMAT;
  formatVersion: number;
  generatedAt: string;
  document: { path: typeof NATIVE_ARCHIVE_DOCUMENT_PATH; bytes: number; sha256: string };
  files: NativeArchiveManifestFile[];
  totals: { files: number; fileBytes: number };
}

export interface ParsedNativeArchiveFile extends NativeArchiveManifestFile {
  blob: Blob;
}

export interface ParsedNativeArchive {
  source: File;
  document: NativeArchiveDocument;
  manifest: NativeArchiveManifest;
  files: ParsedNativeArchiveFile[];
}

interface ZipDirectoryEntry {
  name: string;
  flags: number;
  method: number;
  crc32: number;
  compressedBytes: number;
  bytes: number;
  localOffset: number;
  dataStart: number;
  dataEnd: number;
  recordEnd: number;
}

export interface ArchiveWriteSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface ArchiveUploadEntry {
  id: string;
  blob: Blob;
  contentType: string;
  key: string;
  name: string;
  uploadUrl: string;
}

function archiveError(message: string) {
  return new Error(`Invalid Hanji archive: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function u16(view: DataView, offset: number) {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number) {
  return view.getUint32(offset, true);
}

function exactInteger(value: unknown, label: string, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw archiveError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, max: number) {
  if (typeof value !== "string" || !value.trim()) throw archiveError(`${label} must be a non-empty string.`);
  if (value.length > max || CONTROL_CHARS.test(value)) throw archiveError(`${label} is too long or invalid.`);
  return value;
}

function canonicalJson(bytes: Uint8Array, label: string) {
  let text: string;
  let parsed: unknown;
  try {
    text = decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw archiveError(`${label} is not valid UTF-8 JSON.`);
  }
  if (JSON.stringify(parsed) !== text) throw archiveError(`${label} must use canonical compact JSON.`);
  return parsed;
}

let crcTable: Uint32Array | undefined;
function getCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

async function hashBlob(blob: Blob, expectedBytes: number) {
  const hash = sha256.create();
  const table = getCrcTable();
  let crc = 0xffffffff;
  let bytes = 0;
  const chunkBytes = 1024 * 1024;
  while (bytes < blob.size) {
    const next = new Uint8Array(await blob.slice(bytes, Math.min(blob.size, bytes + chunkBytes)).arrayBuffer());
    bytes += next.byteLength;
    if (bytes > expectedBytes || bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes) {
      throw archiveError("an entry exceeded its declared byte length.");
    }
    hash.update(next);
    for (const byte of next) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  if (bytes !== expectedBytes) throw archiveError("an entry did not match its declared byte length.");
  return { sha256: bytesToHex(hash.digest()), crc32: (crc ^ 0xffffffff) >>> 0 };
}

function validPath(name: string) {
  const bytes = encoder.encode(name).byteLength;
  if (!name || bytes > NATIVE_ARCHIVE_LIMITS.maxPathBytes || CONTROL_CHARS.test(name)) return false;
  if (name.startsWith("/") || name.includes("\\") || name.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return name.split("/").length <= NATIVE_ARCHIVE_LIMITS.maxPathDepth;
}

async function parseZipDirectory(file: File) {
  if (file.size <= 0 || file.size > NATIVE_ARCHIVE_LIMITS.maxArchiveBytes) {
    throw archiveError("archive exceeds the byte limit.");
  }
  const tailStart = Math.max(0, file.size - 65_557);
  const tail = new Uint8Array(await file.slice(tailStart).arrayBuffer());
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let relativeEocd = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (u32(tailView, offset) === 0x06054b50) {
      const commentBytes = u16(tailView, offset + 20);
      if (offset + 22 + commentBytes === tail.byteLength) {
        relativeEocd = offset;
        break;
      }
    }
  }
  if (relativeEocd < 0) throw archiveError("ZIP end-of-directory record is missing.");
  const eocdOffset = tailStart + relativeEocd;
  if (u16(tailView, relativeEocd + 4) !== 0 || u16(tailView, relativeEocd + 6) !== 0) {
    throw archiveError("multi-disk ZIP files are not supported.");
  }
  const diskEntries = u16(tailView, relativeEocd + 8);
  const totalEntries = u16(tailView, relativeEocd + 10);
  const centralBytes = u32(tailView, relativeEocd + 12);
  const centralOffset = u32(tailView, relativeEocd + 16);
  if (diskEntries !== totalEntries || totalEntries < 2 || totalEntries > NATIVE_ARCHIVE_LIMITS.maxEntries) {
    throw archiveError("ZIP entry count is invalid or exceeds the limit.");
  }
  if (centralOffset === 0xffffffff || centralBytes === 0xffffffff || centralOffset + centralBytes !== eocdOffset) {
    throw archiveError("ZIP64, trailing data, and non-canonical central directories are not supported.");
  }
  const central = new Uint8Array(await file.slice(centralOffset, eocdOffset).arrayBuffer());
  const view = new DataView(central.buffer, central.byteOffset, central.byteLength);
  const entries: ZipDirectoryEntry[] = [];
  const names = new Set<string>();
  let offset = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > central.byteLength || u32(view, offset) !== 0x02014b50) {
      throw archiveError("ZIP central directory is truncated or malformed.");
    }
    const madeBy = u16(view, offset + 4);
    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const crc = u32(view, offset + 16);
    const compressedBytes = u32(view, offset + 20);
    const bytes = u32(view, offset + 24);
    const nameBytes = u16(view, offset + 28);
    const extraBytes = u16(view, offset + 30);
    const commentBytes = u16(view, offset + 32);
    const disk = u16(view, offset + 34);
    const externalAttributes = u32(view, offset + 38);
    const localOffset = u32(view, offset + 42);
    const end = offset + 46 + nameBytes + extraBytes + commentBytes;
    if (end > central.byteLength) throw archiveError("ZIP central entry is truncated.");
    let name: string;
    try {
      name = decoder.decode(central.subarray(offset + 46, offset + 46 + nameBytes));
    } catch {
      throw archiveError("ZIP entry name is not valid UTF-8.");
    }
    if (!validPath(name)) throw archiveError(`ZIP path ${name || "(empty)"} is invalid.`);
    if (names.has(name)) throw archiveError(`ZIP contains duplicate path ${name}.`);
    names.add(name);
    if (disk !== 0 || localOffset === 0xffffffff || bytes === 0xffffffff || compressedBytes === 0xffffffff) {
      throw archiveError("ZIP64 and multi-disk entries are not supported.");
    }
    if (flags & 1) throw archiveError("encrypted ZIP entries are not supported.");
    if ((flags & ~0x0808) !== 0) throw archiveError("ZIP entry flags are unsupported.");
    if ((flags & 0x0800) === 0) throw archiveError("ZIP entry names must declare UTF-8.");
    if (method !== 0 || compressedBytes !== bytes) {
      throw archiveError("only store-only ZIP entries with compression ratio 1 are supported.");
    }
    const unixMode = madeBy >>> 8 === 3 ? (externalAttributes >>> 16) & 0xffff : 0;
    if ((unixMode & 0xf000) === 0xa000) throw archiveError("ZIP symbolic-link entries are not supported.");
    entries.push({
      name,
      flags,
      method,
      crc32: crc,
      compressedBytes,
      bytes,
      localOffset,
      dataStart: 0,
      dataEnd: 0,
      recordEnd: 0,
    });
    offset = end;
  }
  if (offset !== central.byteLength) throw archiveError("ZIP central directory has unparsed bytes.");

  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  let expectedOffset = 0;
  for (const entry of ordered) {
    if (entry.localOffset !== expectedOffset || entry.localOffset + 30 > centralOffset) {
      throw archiveError("ZIP local entries overlap or contain unexplained gaps.");
    }
    const localHead = new Uint8Array(await file.slice(entry.localOffset, entry.localOffset + 30).arrayBuffer());
    const localView = new DataView(localHead.buffer, localHead.byteOffset, localHead.byteLength);
    if (localHead.byteLength !== 30 || u32(localView, 0) !== 0x04034b50) throw archiveError("ZIP local header is invalid.");
    const flags = u16(localView, 6);
    const method = u16(localView, 8);
    const localCrc = u32(localView, 14);
    const localCompressed = u32(localView, 18);
    const localBytes = u32(localView, 22);
    const nameBytes = u16(localView, 26);
    const extraBytes = u16(localView, 28);
    if (flags !== entry.flags || method !== entry.method) throw archiveError("ZIP local and central metadata do not match.");
    const variable = new Uint8Array(await file.slice(entry.localOffset + 30, entry.localOffset + 30 + nameBytes + extraBytes).arrayBuffer());
    if (variable.byteLength !== nameBytes + extraBytes) throw archiveError("ZIP local header is truncated.");
    const localName = decoder.decode(variable.subarray(0, nameBytes));
    if (localName !== entry.name) throw archiveError("ZIP local and central names do not match.");
    if ((flags & 0x08) === 0 && (localCrc !== entry.crc32 || localCompressed !== entry.compressedBytes || localBytes !== entry.bytes)) {
      throw archiveError("ZIP local and central sizes do not match.");
    }
    if ((flags & 0x08) !== 0 && !([0, entry.crc32].includes(localCrc)) ) {
      throw archiveError("ZIP streaming local CRC is invalid.");
    }
    if ((flags & 0x08) !== 0 && !([0, entry.bytes].includes(localBytes)) ) {
      throw archiveError("ZIP streaming local size is invalid.");
    }
    entry.dataStart = entry.localOffset + 30 + nameBytes + extraBytes;
    entry.dataEnd = entry.dataStart + entry.bytes;
    entry.recordEnd = entry.dataEnd;
    if (flags & 0x08) {
      const descriptor = new Uint8Array(await file.slice(entry.dataEnd, entry.dataEnd + 16).arrayBuffer());
      const descriptorView = new DataView(descriptor.buffer, descriptor.byteOffset, descriptor.byteLength);
      if (descriptor.byteLength !== 16 || u32(descriptorView, 0) !== 0x08074b50
        || u32(descriptorView, 4) !== entry.crc32
        || u32(descriptorView, 8) !== entry.compressedBytes
        || u32(descriptorView, 12) !== entry.bytes) {
        throw archiveError("ZIP data descriptor is invalid.");
      }
      entry.recordEnd += 16;
    }
    expectedOffset = entry.recordEnd;
  }
  if (expectedOffset !== centralOffset) throw archiveError("ZIP payload and central directory boundaries do not match.");
  return { entries, byName: new Map(entries.map((entry) => [entry.name, entry])) };
}

async function readEntry(file: File, entry: ZipDirectoryEntry, maxBytes: number, label: string) {
  if (entry.bytes > maxBytes) throw archiveError(`${label} exceeds its byte limit.`);
  const bytes = new Uint8Array(await file.slice(entry.dataStart, entry.dataEnd).arrayBuffer());
  const digest = await hashBlob(new Blob([bytes]), entry.bytes);
  if (digest.crc32 !== entry.crc32) throw archiveError(`${label} CRC does not match.`);
  return { bytes, sha256: digest.sha256 };
}

function validateDocument(value: unknown): NativeArchiveDocument {
  if (!isRecord(value) || value.format !== NATIVE_ARCHIVE_FORMAT || value.formatVersion !== NATIVE_ARCHIVE_FORMAT_VERSION) {
    throw archiveError("document format or version is unsupported.");
  }
  if (!isRecord(value.files) || value.files.included !== true) throw archiveError("document must declare included files.");
  const count = exactInteger(value.files.count, "document file count");
  if (count > NATIVE_ARCHIVE_LIMITS.maxFiles) throw archiveError("document file count exceeds the limit.");
  if (!isRecord(value.entities) || !Array.isArray(value.entities.pages)) throw archiveError("document entities are invalid.");
  return value as unknown as NativeArchiveDocument;
}

function validateManifest(value: unknown): NativeArchiveManifest {
  if (!isRecord(value) || value.format !== NATIVE_ARCHIVE_FORMAT || value.formatVersion !== NATIVE_ARCHIVE_FORMAT_VERSION) {
    throw archiveError("manifest format or version is unsupported.");
  }
  if (!isRecord(value.document) || value.document.path !== NATIVE_ARCHIVE_DOCUMENT_PATH) {
    throw archiveError("manifest document descriptor is invalid.");
  }
  exactInteger(value.document.bytes, "manifest document bytes");
  if (typeof value.document.sha256 !== "string" || !SHA256_HEX.test(value.document.sha256)) throw archiveError("manifest document digest is invalid.");
  if (!Array.isArray(value.files) || value.files.length > NATIVE_ARCHIVE_LIMITS.maxFiles) throw archiveError("manifest file count exceeds the limit.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  let total = 0;
  const files = value.files.map((item, index): NativeArchiveManifestFile => {
    if (!isRecord(item)) throw archiveError(`manifest file ${index} is invalid.`);
    const id = boundedString(item.id, `manifest file ${index} id`, 32);
    const path = boundedString(item.path, `manifest file ${index} path`, NATIVE_ARCHIVE_LIMITS.maxPathBytes);
    if (!FILE_ID.test(id) || path !== `files/${id}` || !validPath(path)) throw archiveError(`manifest file ${index} path is invalid.`);
    if (ids.has(id) || paths.has(path)) throw archiveError("manifest contains duplicate file ids or paths.");
    ids.add(id);
    paths.add(path);
    const bytes = exactInteger(item.bytes, `manifest file ${index} bytes`);
    if (bytes > NATIVE_ARCHIVE_LIMITS.maxFileBytes) throw archiveError(`manifest file ${index} exceeds the per-file limit.`);
    total += bytes;
    if (total > NATIVE_ARCHIVE_LIMITS.maxTotalFileBytes) throw archiveError("manifest exceeds the total byte limit.");
    const digest = boundedString(item.sha256, `manifest file ${index} digest`, 64);
    if (!SHA256_HEX.test(digest)) throw archiveError(`manifest file ${index} digest is invalid.`);
    return {
      id,
      path,
      name: boundedString(item.name, `manifest file ${index} name`, 180),
      contentType: boundedString(item.contentType, `manifest file ${index} content type`, 128),
      scope: boundedString(item.scope, `manifest file ${index} scope`, 64),
      bytes,
      sha256: digest,
    };
  });
  if (!isRecord(value.totals)
    || exactInteger(value.totals.files, "manifest total files") !== files.length
    || exactInteger(value.totals.fileBytes, "manifest total bytes") !== total) {
    throw archiveError("manifest totals do not match its files.");
  }
  return { ...value, files } as unknown as NativeArchiveManifest;
}

async function mapBounded<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>) {
  const results = new Array<R>(items.length);
  const failures = new Map<number, unknown>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        failures.set(index, error);
      }
    }
  }));
  if (failures.size > 0) {
    const firstIndex = Math.min(...failures.keys());
    throw failures.get(firstIndex);
  }
  return results;
}

export function isNativeArchiveFile(file: File) {
  return /\.hanji\.zip$/i.test(file.name);
}

export async function parseNativeArchive(file: File): Promise<ParsedNativeArchive> {
  if (!isNativeArchiveFile(file)) throw archiveError("file name must end in .hanji.zip.");
  const directory = await parseZipDirectory(file);
  const documentEntry = directory.byName.get(NATIVE_ARCHIVE_DOCUMENT_PATH);
  const manifestEntry = directory.byName.get(NATIVE_ARCHIVE_MANIFEST_PATH);
  if (!documentEntry || !manifestEntry) throw archiveError("document or manifest entry is missing.");
  const documentRead = await readEntry(file, documentEntry, NATIVE_ARCHIVE_LIMITS.maxDocumentBytes, "document");
  const manifestRead = await readEntry(file, manifestEntry, NATIVE_ARCHIVE_LIMITS.maxManifestBytes, "manifest");
  const document = validateDocument(canonicalJson(documentRead.bytes, "document"));
  const manifest = validateManifest(canonicalJson(manifestRead.bytes, "manifest"));
  if (manifest.document.bytes !== documentEntry.bytes || manifest.document.sha256 !== documentRead.sha256) {
    throw archiveError("document digest or byte length does not match the manifest.");
  }
  if (document.files.count !== manifest.files.length) throw archiveError("document and manifest file counts do not match.");
  const expectedPaths = new Set([NATIVE_ARCHIVE_DOCUMENT_PATH, NATIVE_ARCHIVE_MANIFEST_PATH, ...manifest.files.map((item) => item.path)]);
  if (expectedPaths.size !== directory.entries.length || directory.entries.some((entry) => !expectedPaths.has(entry.name))) {
    throw archiveError("ZIP entries do not exactly match the manifest.");
  }
  const files = await mapBounded(manifest.files, NATIVE_ARCHIVE_LIMITS.heavyConcurrency, async (item) => {
    const entry = directory.byName.get(item.path);
    if (!entry || entry.bytes !== item.bytes) throw archiveError(`file ${item.id} byte length does not match.`);
    const blob = file.slice(entry.dataStart, entry.dataEnd, item.contentType);
    const digest = await hashBlob(blob, item.bytes);
    if (digest.crc32 !== entry.crc32) throw archiveError(`file ${item.id} CRC does not match.`);
    if (digest.sha256 !== item.sha256) throw archiveError(`file ${item.id} digest does not match.`);
    return { ...item, blob };
  });
  const serialized = JSON.stringify(document);
  const markerIds = new Set<string>();
  for (const match of serialized.matchAll(/hanji-archive:\/\/files\/(file-\d{6})/g)) markerIds.add(match[1]);
  if (serialized.includes(FILE_MARKER_PREFIX) && markerIds.size === 0) throw archiveError("document file markers are malformed.");
  if (markerIds.size !== manifest.files.length || manifest.files.some((item) => !markerIds.has(item.id))) {
    throw archiveError("document file markers do not exactly match the manifest.");
  }
  return { source: file, document, manifest, files };
}

export async function uploadNativeArchiveEntries(
  entries: ArchiveUploadEntry[],
  options: {
    concurrency?: number;
    fetcher?: typeof fetch;
  } = {},
) {
  const concurrency = Math.max(1, Math.min(NATIVE_ARCHIVE_LIMITS.heavyConcurrency, options.concurrency ?? NATIVE_ARCHIVE_LIMITS.heavyConcurrency));
  const fetcher = options.fetcher ?? fetch;
  const results = await mapBounded(entries, concurrency, async (entry) => {
    try {
      const form = new FormData();
      const blob = entry.blob.type === entry.contentType
        ? entry.blob
        : entry.blob.slice(0, entry.blob.size, entry.contentType);
      form.append("file", blob, entry.name);
      form.append("key", entry.key);
      const response = await fetcher(entry.uploadUrl, {
        method: "POST",
        body: form,
      });
      return response.ok ? null : { id: entry.id, status: response.status };
    } catch {
      return { id: entry.id, status: 0 };
    }
  });
  return { failures: results.filter((result): result is { id: string; status: number } => result !== null) };
}

export async function pipeArchiveResponseToSink(response: Response, sink: ArchiveWriteSink) {
  if (!response.body) throw new Error("Archive response did not include a readable stream.");
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      await sink.write(next.value);
    }
    await sink.close();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await sink.abort(error).catch(() => undefined);
    throw error;
  }
}

interface FileSystemWritableLike {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<FileSystemWritableLike>;
  getFile?(): Promise<File>;
}

interface FileSystemDirectoryHandleLike {
  getFileHandle(name: string, options: { create: true }): Promise<FileSystemFileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

function writableSink(writable: FileSystemWritableLike): ArchiveWriteSink {
  return {
    write: (chunk) => writable.write(Uint8Array.from(chunk).buffer),
    close: () => writable.close(),
    abort: (reason) => writable.abort(reason),
  };
}

function clickDownload(file: File, name: string, cleanup: () => Promise<void>) {
  const url = URL.createObjectURL(file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    void cleanup();
  }, 60_000);
}

export async function saveNativeArchiveResponse(response: Response, suggestedName: string) {
  const globalWithPicker = globalThis as typeof globalThis & {
    showSaveFilePicker?: (options: Record<string, unknown>) => Promise<FileSystemFileHandleLike>;
  };
  if (globalWithPicker.showSaveFilePicker) {
    let writable: FileSystemWritableLike;
    try {
      const handle = await globalWithPicker.showSaveFilePicker({
        suggestedName,
        types: [{ description: "Hanji archive", accept: { [NATIVE_ARCHIVE_MIME]: [".hanji.zip"] } }],
      });
      writable = await handle.createWritable();
    } catch (error) {
      await response.body?.cancel(error).catch(() => undefined);
      throw error;
    }
    await pipeArchiveResponseToSink(response, writableSink(writable));
    return;
  }
  const storageWithDirectory = navigator.storage as StorageManager & {
    getDirectory?: () => Promise<FileSystemDirectoryHandleLike>;
  };
  if (!storageWithDirectory?.getDirectory) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("This browser cannot save a streamed Hanji archive. Use a current Chrome, Edge, or Safari release.");
  }
  const root = await storageWithDirectory.getDirectory();
  const tempName = `.hanji-export-${crypto.randomUUID()}.tmp`;
  const handle = await root.getFileHandle(tempName, { create: true });
  try {
    await pipeArchiveResponseToSink(response, writableSink(await handle.createWritable()));
    const file = await handle.getFile?.();
    if (!file) throw new Error("The browser could not reopen the completed archive.");
    clickDownload(file, suggestedName, () => root.removeEntry(tempName));
  } catch (error) {
    await root.removeEntry(tempName).catch(() => undefined);
    throw error;
  }
}
