const MAX_INLINE_BYTES = 200 * 1024;
const MAX_URL_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 60 * 60 * 1000;
const TEXT_TYPES = new Map([
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["txt", "text/plain"],
  ["csv", "text/csv"],
  ["json", "application/json"],
  ["yaml", "application/yaml"],
  ["yml", "application/yaml"],
  ["tsv", "text/tab-separated-values"],
  ["ics", "text/calendar"],
]);

function extension(filename) {
  return String(filename ?? "").trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
}

function inlineContentType(filename, requested) {
  const inferred = TEXT_TYPES.get(extension(filename));
  if (!inferred) {
    throw new Error("Inline attachments support .md, .markdown, .txt, .csv, .json, .yaml, .yml, .tsv, and .ics files. Use source_url for other safe file types.");
  }
  const explicit = String(requested ?? "").split(";", 1)[0].trim().toLowerCase();
  if (explicit && explicit !== inferred) throw new Error(`content_type must match ${filename} (${inferred}).`);
  return inferred;
}

function uploadPayload(upload, filename) {
  return {
    object: "file_upload",
    id: upload.id,
    file_upload_id: upload.id,
    filename,
    content_type: upload.contentType ?? upload.content_type ?? null,
    content_length: upload.size ?? upload.content_length ?? null,
    status: upload.status ?? null,
    markdown_source: `<file src="file-upload://${upload.id}">`,
  };
}

async function responseBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`Attachment exceeds the ${limit} byte limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit) throw new Error(`Attachment exceeds the ${limit} byte limit.`);
  return bytes;
}

export function createNotionAttachmentHandlers({ eb, requireWorkspaceSelection, okJson, fail }) {
  const created = new Map();
  const prune = () => {
    const now = Date.now();
    for (const [id, entry] of created) if (entry.expiresAt <= now) created.delete(id);
  };

  const handleCreate = async ({
    workspace_id = undefined,
    teamspace_id = undefined,
    filename = undefined,
    content_type = undefined,
    content = undefined,
    source_url = undefined,
  } = {}) => {
    try {
      prune();
      const required = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "notion-create-attachment");
      if (required.errorResult) return required.errorResult;
      const name = String(filename ?? "").trim();
      if (!name) throw new Error("filename is required.");
      const hasContent = typeof content === "string";
      const sourceUrl = String(source_url ?? "").trim();
      if (hasContent === !!sourceUrl) throw new Error("Provide exactly one of content or source_url.");
      let upload;
      if (hasContent) {
        const bytes = new TextEncoder().encode(content);
        if (!bytes.byteLength) throw new Error("content must not be empty.");
        if (bytes.byteLength > MAX_INLINE_BYTES) {
          throw new Error("Inline attachment content must be at most 200 KiB after UTF-8 encoding.");
        }
        const contentType = inlineContentType(name, content_type);
        const prepared = await eb.prepareFileUpload({
          workspaceId: required.workspaceId,
          scope: "uploads",
          name,
          size: bytes.byteLength,
          contentType,
        });
        upload = prepared?.upload;
        if (!upload?.id || !upload?.key || !prepared?.uploadUrl) throw new Error("File upload preparation did not return a usable grant.");
        try {
          const form = new FormData();
          form.append("file", new Blob([bytes], { type: contentType }), upload.key);
          form.append("key", upload.key);
          form.append("customMetadata", JSON.stringify({
            uploadId: upload.id,
            workspaceId: required.workspaceId,
            originalName: name,
            source: "notion-create-attachment",
          }));
          const sent = await fetch(prepared.uploadUrl, {
            method: "POST",
            body: form,
            redirect: "error",
            signal: AbortSignal.timeout(30_000),
          });
          if (!sent.ok) throw new Error(`Signed attachment upload returned HTTP ${sent.status}.`);
          upload = await eb.completeFileUpload({ id: upload.id, key: upload.key });
        } catch (error) {
          await eb.deleteFile({ workspaceId: required.workspaceId, uploadId: upload.id }).catch(() => {});
          throw error;
        }
      } else {
        if (!/^https:\/\//i.test(sourceUrl)) throw new Error("source_url must be a public HTTPS URL.");
        upload = await eb.createNotionFileUpload({
          workspace_id: required.workspaceId,
          mode: "external_url",
          filename: name,
          content_type: String(content_type ?? "").trim() || "application/octet-stream",
          external_url: sourceUrl,
          scope: "uploads",
        });
        const size = Number(upload?.content_length);
        if (!Number.isFinite(size) || size <= 0 || size > MAX_URL_BYTES) {
          if (upload?.id) await eb.deleteFile({ workspaceId: required.workspaceId, uploadId: upload.id }).catch(() => {});
          throw new Error("URL attachment downloads must be non-empty and at most 5 MiB.");
        }
      }
      const payload = uploadPayload(upload, name);
      created.set(upload.id, {
        workspaceId: required.workspaceId,
        filename: name,
        contentType: payload.content_type,
        size: Number(payload.content_length),
        expiresAt: Date.now() + ATTACHMENT_TTL_MS,
      });
      return okJson(payload);
    } catch (error) {
      return fail(error);
    }
  };

  const handleDownload = async ({ file_upload_id = undefined } = {}) => {
    try {
      prune();
      const id = String(file_upload_id ?? "").trim();
      if (!id) throw new Error("file_upload_id is required.");
      const attachment = created.get(id);
      if (!attachment) throw new Error("Attachment was not found for this MCP process.");
      if (!TEXT_TYPES.has(extension(attachment.filename))) {
        throw new Error("Only supported UTF-8 text attachments can be downloaded through this tool.");
      }
      if (!Number.isFinite(attachment.size) || attachment.size < 0 || attachment.size > MAX_INLINE_BYTES) {
        throw new Error("Attachment is larger than the 200 KiB text download limit.");
      }
      const signed = await eb.fileDownloadUrl({
        workspaceId: attachment.workspaceId,
        uploadId: id,
        expiresIn: "5m",
      });
      const response = await fetch(signed.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Attachment download returned HTTP ${response.status}.`);
      const bytes = await responseBytes(response, MAX_INLINE_BYTES);
      if (bytes.byteLength !== attachment.size) throw new Error("Attachment download failed its size verification.");
      let decoded;
      try {
        decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new Error("Attachment is not valid UTF-8 text.");
      }
      return okJson({
        file_upload_id: id,
        filename: attachment.filename,
        content_type: attachment.contentType,
        content: decoded,
      });
    } catch (error) {
      return fail(error);
    }
  };

  return { handleCreate, handleDownload };
}

export function registerNotionAttachmentTools({ registrar, z, handlers }) {
  registrar.registerTool("notion-create-attachment", {
    title: "Create attachment",
    description: "Create a real temporary Hanji file upload from small UTF-8 content or a direct public HTTPS source. Requires an explicit workspace_id. Inline content supports safe Markdown, text, CSV, JSON, YAML, TSV, and calendar files up to 200 KiB; URL imports are capped at 5 MiB.",
    inputSchema: {
      workspace_id: z.string().optional(),
      teamspace_id: z.string().optional(),
      filename: z.string(),
      content_type: z.string().optional(),
      content: z.string().optional(),
      source_url: z.string().optional(),
    },
  }, handlers.handleCreate);
  registrar.registerTool("notion-download-attachment", {
    title: "Download attachment",
    description: "Download complete UTF-8 text content up to 200 KiB from a temporary attachment created by this stdio MCP process.",
    inputSchema: { file_upload_id: z.string() },
  }, handlers.handleDownload);
}
