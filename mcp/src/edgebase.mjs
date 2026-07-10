// Minimal EdgeBase HTTP client for the MCP server.
// Talks to the local Notionlike backend's REST API (validated endpoints).

import { readFileSync, statSync } from "node:fs";

const BASE = process.env.NOTIONLIKE_EDGEBASE_URL || "http://localhost:8787";
const DATABASE_MUTATION_TABLES = new Set(["db_properties", "db_views", "db_templates"]);
// 429/503 are emitted before the backend commits any work, so every call may
// retry them. 504 is ambiguous for mutations — the gateway can time out AFTER
// the write committed, and replaying a non-idempotent POST (append, import)
// would duplicate it — so only read-only calls retry 504.
const RETRYABLE_READ_HTTP_STATUSES = new Set([429, 503, 504]);
const RETRYABLE_MUTATION_HTTP_STATUSES = new Set([429, 503]);
const READ_ACTIONS_BY_FUNCTION = new Map([
  ["/functions/workspace-bootstrap", null],
  ["/functions/page-query", null],
  ["/functions/workspace-mutation", new Set([
    "list",
    "listOrganizations",
    "organizationDirectory",
    "searchOrganizationPeople",
    "members",
  ])],
  ["/functions/share-mutation", new Set(["get", "publicPage"])],
  ["/functions/file-mutation", new Set(["list", "report", "organizationReport", "signedUrl"])],
  ["/functions/notification-mutation", new Set(["list"])],
  ["/functions/import-export", new Set([
    "exportPageMarkdown",
    "exportDatabaseCsv",
    "exportWorkspaceMarkdown",
  ])],
  ["/functions/notion-import", new Set(["listConnections", "list", "get"])],
]);

// Cached auth/session state. `tokenPromise`/`workspacePromise` single-flight
// concurrent first calls so parallel tool invocations cannot mint two
// anonymous identities or bootstrap the workspace twice.
let token = null;
let tokenIsStatic = false;
let tokenExpiresAtMs = 0;
let refreshToken = null;
let tokenPromise = null;
let bootstrappedWorkspace = null;
let workspacePromise = null;

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function envCsvSet(name) {
  const raw = process.env[name] ?? "";
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function policyStringSet(value) {
  if (Array.isArray(value)) {
    return new Set(value.map((item) => String(item).trim()).filter(Boolean));
  }
  if (typeof value === "string") {
    return new Set(value.split(",").map((item) => item.trim()).filter(Boolean));
  }
  return new Set();
}

function optionalPolicyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function policySubjectType(value, path) {
  const raw = optionalPolicyString(value);
  if (!raw) return undefined;
  const normalized = raw.toLowerCase().replace(/[-\s]+/g, "_");
  if (["user", "service_principal", "integration", "bot"].includes(normalized)) return normalized;
  throw new Error(
    `MCP policy file ${path || "(environment)"} field subjectType must be user, service_principal, integration, or bot.`,
  );
}

function narrowSet(base, narrowing) {
  if (!base.size) return new Set(narrowing);
  if (!narrowing.size) return new Set(base);
  return new Set(Array.from(base).filter((id) => narrowing.has(id)));
}

function configuredPolicyFilePath() {
  return (
    process.env.NOTIONLIKE_MCP_POLICY_FILE ??
    process.env.NOTIONLIKE_MCP_CONSENT_FILE ??
    ""
  ).trim();
}

let policyFileCache = null;

function configuredPolicyFile() {
  const path = configuredPolicyFilePath();
  if (!path) return { path: "", data: {} };
  try {
    // Cache the parsed policy by mtime: every api() call consults the policy
    // several times and the file rarely changes, so re-read and re-parse only
    // when the mtime moves. Live edits to the file still apply.
    const mtimeMs = statSync(path).mtimeMs;
    if (!policyFileCache || policyFileCache.path !== path || policyFileCache.mtimeMs !== mtimeMs) {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("policy file must contain a JSON object");
      }
      policyFileCache = { path, mtimeMs, data: parsed };
    }
    return { path, data: policyFileCache.data };
  } catch (error) {
    policyFileCache = null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read MCP policy file ${path}: ${message}`);
  }
}

function optionalPolicyTimestamp(value, name, path) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new Error(`MCP policy file ${path} field ${name} must be an ISO timestamp string.`);
  }
  const trimmed = value.trim();
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`MCP policy file ${path} field ${name} is not a valid timestamp.`);
  }
  return { iso: new Date(ms).toISOString(), ms };
}

function policyValidityWindow(file) {
  if (!file.path) return { notBefore: null, expiresAt: null };
  const notBefore = optionalPolicyTimestamp(
    file.data.notBefore ?? file.data.not_before,
    "notBefore",
    file.path,
  );
  const expiresAt = optionalPolicyTimestamp(
    file.data.expiresAt ?? file.data.expires_at,
    "expiresAt",
    file.path,
  );
  if (notBefore && expiresAt && expiresAt.ms <= notBefore.ms) {
    throw new Error(`MCP policy file ${file.path} expires before its validity window opens.`);
  }
  const now = Date.now();
  if (notBefore && now < notBefore.ms) {
    throw new Error(`MCP policy file ${file.path} is not valid until ${notBefore.iso}.`);
  }
  if (expiresAt && now >= expiresAt.ms) {
    throw new Error(`MCP policy file ${file.path} expired at ${expiresAt.iso}.`);
  }
  return { notBefore: notBefore?.iso ?? null, expiresAt: expiresAt?.iso ?? null };
}

function configuredMcpPolicy() {
  const file = configuredPolicyFile();
  const validity = policyValidityWindow(file);
  const fileReadOnly =
    file.data.readOnly === true ||
    file.data.read_only === true ||
    file.data.allowWrites === false ||
    file.data.allow_writes === false;
  const fileWorkspaceIds = policyStringSet(file.data.allowedWorkspaceIds ?? file.data.allowed_workspace_ids);
  const filePageIds = policyStringSet(file.data.allowedPageIds ?? file.data.allowed_page_ids);
  const fileDatabaseIds = policyStringSet(file.data.allowedDatabaseIds ?? file.data.allowed_database_ids);
  const envWorkspaceIds = envCsvSet("NOTIONLIKE_MCP_ALLOWED_WORKSPACE_IDS");
  const envPageIds = envCsvSet("NOTIONLIKE_MCP_ALLOWED_PAGE_IDS");
  const envDatabaseIds = envCsvSet("NOTIONLIKE_MCP_ALLOWED_DATABASE_IDS");
  const fileScopes = policyStringSet(file.data.scopes ?? file.data.allowedScopes ?? file.data.allowed_scopes);
  const envScopes = envCsvSet("NOTIONLIKE_MCP_SCOPES");
  const subjectType = policySubjectType(
    process.env.NOTIONLIKE_MCP_SUBJECT_TYPE ??
      file.data.subjectType ??
      file.data.subject_type,
    file.path,
  );
  const readOnly = envFlag("NOTIONLIKE_MCP_READ_ONLY", false) ||
    envFlag("NOTIONLIKE_MCP_ALLOW_WRITES", true) === false ||
    fileReadOnly;
  return {
    readOnly,
    allowedWorkspaceIds: narrowSet(fileWorkspaceIds, envWorkspaceIds),
    allowedPageIds: narrowSet(filePageIds, envPageIds),
    allowedDatabaseIds: narrowSet(fileDatabaseIds, envDatabaseIds),
    scopes: narrowSet(fileScopes, envScopes),
    clientId: typeof file.data.clientId === "string" ? file.data.clientId : undefined,
    clientName: typeof file.data.clientName === "string" ? file.data.clientName : undefined,
    subjectType,
    subjectId: optionalPolicyString(
      process.env.NOTIONLIKE_MCP_SUBJECT_ID,
      process.env.NOTIONLIKE_MCP_SERVICE_PRINCIPAL_ID,
      file.data.subjectId,
      file.data.subject_id,
      file.data.servicePrincipalId,
      file.data.service_principal_id,
    ),
    issuer: optionalPolicyString(
      process.env.NOTIONLIKE_MCP_POLICY_ISSUER,
      file.data.issuer,
      file.data.iss,
    ),
    audience: optionalPolicyString(
      process.env.NOTIONLIKE_MCP_POLICY_AUDIENCE,
      process.env.NOTIONLIKE_MCP_RESOURCE,
      file.data.audience,
      file.data.aud,
      file.data.resource,
    ),
    transport: optionalPolicyString(
      process.env.NOTIONLIKE_MCP_TRANSPORT,
      file.data.transport,
    ) ?? "stdio",
    provisioningId: optionalPolicyString(
      process.env.NOTIONLIKE_MCP_PROVISIONING_ID,
      file.data.provisioningId,
      file.data.provisioning_id,
      file.data.consentId,
      file.data.consent_id,
    ),
    notBefore: validity.notBefore,
    expiresAt: validity.expiresAt,
    policyFile: file.path || undefined,
  };
}

function publicMcpPolicy(policy = configuredMcpPolicy()) {
  return {
    readOnly: policy.readOnly,
    allowedWorkspaceIds: Array.from(policy.allowedWorkspaceIds),
    allowedPageIds: Array.from(policy.allowedPageIds),
    allowedDatabaseIds: Array.from(policy.allowedDatabaseIds),
    scopes: Array.from(policy.scopes),
    policyFile: policy.policyFile ?? null,
    clientId: policy.clientId ?? null,
    clientName: policy.clientName ?? null,
    subjectType: policy.subjectType ?? null,
    subjectId: policy.subjectId ?? null,
    issuer: policy.issuer ?? null,
    audience: policy.audience ?? null,
    transport: policy.transport ?? null,
    provisioningId: policy.provisioningId ?? null,
    notBefore: policy.notBefore ?? null,
    expiresAt: policy.expiresAt ?? null,
  };
}

function mcpClientMetadata(policy = configuredMcpPolicy()) {
  const envClientId = process.env.NOTIONLIKE_MCP_CLIENT_ID?.trim();
  const envClientName = process.env.NOTIONLIKE_MCP_CLIENT_NAME?.trim();
  const clientId = envClientId || policy.clientId?.trim() || "notionlike-mcp";
  const clientName = envClientName || policy.clientName?.trim() || "Notionlike MCP";
  return {
    source: "mcp",
    clientId,
    clientName,
    readOnly: policy.readOnly,
    subjectType: policy.subjectType ?? null,
    subjectId: policy.subjectId ?? null,
    issuer: policy.issuer ?? null,
    audience: policy.audience ?? null,
    transport: policy.transport ?? "stdio",
    provisioningId: policy.provisioningId ?? null,
  };
}

function optionalClientHeader(headers, name, value) {
  if (typeof value === "string" && value.trim()) headers[name] = value.trim();
}

function actionOf(body) {
  return body && typeof body === "object" && typeof body.action === "string" ? body.action : "";
}

function normalizeScope(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[-\s]+/g, "_");
}

const ORGANIZATION_ADMIN_ACTIONS = new Set([
  "updateOrganizationSettings",
  "transferOrganizationOwner",
  "deactivateOrganizationMember",
  "reactivateOrganizationMember",
  "removeOrganizationMember",
  "createOrganizationGroup",
  "updateOrganizationGroup",
  "deleteOrganizationGroup",
  "addOrganizationGroupMember",
  "removeOrganizationGroupMember",
  "addOrganizationDomain",
  "verifyOrganizationDomain",
  "removeOrganizationDomain",
]);

const ORGANIZATION_READ_ACTIONS = new Set([
  "listOrganizations",
  "organizationDirectory",
  "searchOrganizationPeople",
]);

const WORKSPACE_ADMIN_ACTIONS = new Set([
  "createWorkspace",
  "deleteWorkspace",
  "members",
  "inviteMember",
  "updateMyProfile",
  "updateMemberRole",
  "transferWorkspaceOwner",
  "removeMember",
  "removeInvitation",
  "acceptInvitation",
]);

function scopesForOperation(path, body) {
  const action = actionOf(body);
  if (path === "/functions/workspace-mutation") {
    if (action === "recordMcpClientAction" || action === "list") return [];
    if (ORGANIZATION_ADMIN_ACTIONS.has(action)) return ["organization_admin"];
    if (ORGANIZATION_READ_ACTIONS.has(action)) return ["organization"];
    if (WORKSPACE_ADMIN_ACTIONS.has(action)) return ["workspace_admin"];
    return [];
  }
  if (path === "/functions/workspace-bootstrap") return [];
  if (path === "/functions/page-query") {
    if (action === "comments" || action === "comment") return ["comments"];
    if (action === "database" || action === "databaseRows") return ["databases"];
    return ["pages"];
  }
  if (path === "/functions/page-mutation" || path === "/functions/block-mutation" || path === "/functions/duplicate-page") {
    return ["pages"];
  }
  if (path === "/functions/comment-mutation") return ["comments"];
  if (path === "/functions/database-mutation" || path === "/functions/database-row-mutation") return ["databases"];
  if (path === "/functions/share-mutation") return ["sharing"];
  if (path === "/functions/file-mutation") return ["files"];
  if (path === "/functions/notification-mutation") return ["notifications"];
  if (path === "/functions/import-export") return ["import_export"];
  if (path === "/functions/notion-import") return ["notion_import"];
  return [];
}

function scopeAllowed(scope, scopes) {
  if (!scopes.size) return true;
  const normalized = normalizeScope(scope);
  if (scopes.has(normalized)) return true;
  if (normalized === "organization" && scopes.has("organization_admin")) return true;
  if (normalized === "workspace" && scopes.has("workspace_admin")) return true;
  return false;
}

function assertAllowedScopes(path, body, policy) {
  if (!policy.scopes.size) return;
  const scopes = new Set(Array.from(policy.scopes).map(normalizeScope).filter(Boolean));
  if (scopes.has("*") || scopes.has("all")) return;
  const required = scopesForOperation(path, body);
  const denied = required.filter((scope) => !scopeAllowed(scope, scopes));
  if (denied.length) {
    throw new Error(
      `MCP access policy denied scope ${denied.join(", ")} for this operation. ` +
        `This MCP client is narrowed by scoped consent.`,
    );
  }
}

function isReadOnlyAllowedOperation(path, method, body) {
  if (method === "GET") return true;
  const allowedActions = READ_ACTIONS_BY_FUNCTION.get(path);
  if (allowedActions === null) return true;
  if (!allowedActions) return false;
  return allowedActions.has(actionOf(body));
}

/**
 * Retry classification for a backend call. Read-only calls (GET requests,
 * read-only functions, and list/get/query/search actions per
 * READ_ACTIONS_BY_FUNCTION) can safely retry 504 because replaying them cannot
 * duplicate committed work; mutations retry only the statuses the backend
 * emits before committing anything (429/503).
 * @param {string} path
 * @param {string} [method]
 * @param {any} [body]
 */
export function retryableHttpStatuses(path, method = "GET", body = undefined) {
  return isReadOnlyAllowedOperation(path, method, body)
    ? RETRYABLE_READ_HTTP_STATUSES
    : RETRYABLE_MUTATION_HTTP_STATUSES;
}

function collectStringIds(value, keys, out = new Set()) {
  if (!value || typeof value !== "object") return out;
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "string" && raw.trim()) out.add(raw.trim());
  }
  return out;
}

export function collectPolicyIds(path, body) {
  const workspaceIds = collectStringIds(body, ["workspaceId", "targetWorkspaceId"]);
  const pageIds = collectStringIds(body, ["pageId", "parentPageId"]);
  const databaseIds = collectStringIds(body, ["databaseId"]);

  if (path === "/functions/page-mutation" && typeof body?.id === "string") pageIds.add(body.id);
  if (path === "/functions/page-mutation" && typeof body?.parentId === "string") {
    if (body.parentType === "database") databaseIds.add(body.parentId);
    else pageIds.add(body.parentId);
  }
  // Block/comment mutations are page-scoped. A create carries the owning
  // pageId, but update/delete target an existing resource by bare id. When a
  // pageId is present it resolves the resource against the page allowlist; when
  // it is absent, the raw id must itself be captured so
  // assertAllowedPageResourceIds does NOT early-return — otherwise a
  // policy-narrowed client could mutate ANY block/comment by passing a bare id.
  if (path === "/functions/block-mutation" || path === "/functions/comment-mutation") {
    if (typeof body?.pageId === "string") pageIds.add(body.pageId);
    else if (
      typeof body?.id === "string" &&
      (actionOf(body) === "update" || actionOf(body) === "delete")
    ) {
      pageIds.add(body.id);
    }
  }
  // page-query's single-comment read targets an existing comment by bare id
  // (eb.getOne("comments", id) sends { action: "comment", commentId }). Capture
  // it like the block/comment mutation targets above so a policy-narrowed
  // client cannot read arbitrary comments through the bare-id path.
  if (
    path === "/functions/page-query" &&
    typeof body?.commentId === "string" &&
    typeof body?.pageId !== "string"
  ) {
    pageIds.add(body.commentId);
  }
  if (path === "/functions/duplicate-page" && typeof body?.pageId === "string") pageIds.add(body.pageId);
  if (path === "/functions/share-mutation" && typeof body?.pageId === "string") pageIds.add(body.pageId);
  if (path === "/functions/import-export") {
    if (typeof body?.pageId === "string") pageIds.add(body.pageId);
    if (typeof body?.databaseId === "string") databaseIds.add(body.databaseId);
    // An import's destination parent is written into, so it needs consent
    // like the move/duplicate destination parents.
    if (typeof body?.parentId === "string" && body.parentId) {
      if (body.parentType === "database") databaseIds.add(body.parentId);
      else pageIds.add(body.parentId);
    }
  }
  if (path === "/functions/database-mutation" && body?.record && typeof body.record === "object") {
    collectStringIds(body.record, ["workspaceId"], workspaceIds);
    collectStringIds(body.record, ["pageId", "parentPageId"], pageIds);
    collectStringIds(body.record, ["databaseId"], databaseIds);
    // A relation/rollup property's target database is read/written through, so
    // its config's relationDatabaseId must sit inside the allowlist.
    if (typeof body.record.config?.relationDatabaseId === "string") {
      databaseIds.add(body.record.config.relationDatabaseId);
    }
  }
  // createDatabase ships its destination parent as a top-level option, like the
  // page-mutation parentId handling above.
  if (path === "/functions/database-mutation" && typeof body?.parentId === "string" && body.parentId) {
    if (body.parentType === "database") databaseIds.add(body.parentId);
    else pageIds.add(body.parentId);
  }
  if (path === "/functions/database-row-mutation") {
    if (typeof body?.databaseId === "string") databaseIds.add(body.databaseId);
    if (typeof body?.id === "string") pageIds.add(body.id);
    if (typeof body?.rowId === "string") pageIds.add(body.rowId);
    // A move's target sibling is read (its position — and its title in the
    // response), so it must sit inside the allowlist like the moved row.
    if (typeof body?.targetId === "string") pageIds.add(body.targetId);
  }
  // A page move ships its destination inside `patch`; the destination parent
  // is written into, so it needs consent like any other referenced parent.
  if (path === "/functions/page-mutation" && body?.patch && typeof body.patch === "object") {
    const patch = body.patch;
    if (typeof patch.parentId === "string" && patch.parentId) {
      if ((patch.parentType ?? body.parentType) === "database") databaseIds.add(patch.parentId);
      else pageIds.add(patch.parentId);
    }
  }
  // duplicate-page's destination parent arrives as a top-level option.
  if (path === "/functions/duplicate-page" && typeof body?.parentId === "string" && body.parentId) {
    if (body.parentType === "database") databaseIds.add(body.parentId);
    else pageIds.add(body.parentId);
  }
  return { workspaceIds, pageIds, databaseIds };
}

function assertAllowedIds(kind, ids, allowed) {
  if (!allowed.size || !ids.size) return;
  const denied = Array.from(ids).filter((id) => !allowed.has(id));
  if (denied.length) {
    throw new Error(
      `MCP access policy denied ${kind} ${denied.join(", ")}. ` +
        `This MCP client is narrowed by an allowlist.`,
    );
  }
}

function assertAllowedPageResourceIds(ids, policy) {
  if ((!policy.allowedPageIds.size && !policy.allowedDatabaseIds.size) || !ids.size) return;
  const denied = Array.from(ids).filter((id) =>
    !policy.allowedPageIds.has(id) && !policy.allowedDatabaseIds.has(id)
  );
  if (denied.length) {
    throw new Error(
      `MCP access policy denied page ${denied.join(", ")}. ` +
        `This MCP client is narrowed by an allowlist.`,
    );
  }
}

function assertAllowedDatabaseResourceIds(ids, policy) {
  if ((!policy.allowedDatabaseIds.size && !policy.allowedPageIds.size) || !ids.size) return;
  const denied = Array.from(ids).filter((id) =>
    !policy.allowedDatabaseIds.has(id) && !policy.allowedPageIds.has(id)
  );
  if (denied.length) {
    throw new Error(
      `MCP access policy denied database ${denied.join(", ")}. ` +
        `This MCP client is narrowed by an allowlist.`,
    );
  }
}

function isAllowedBySet(id, allowed) {
  return !allowed.size || allowed.has(id);
}

function pageMatchesMcpPolicy(page, policy = configuredMcpPolicy()) {
  if (!page || typeof page.id !== "string") return false;
  if (!policy.allowedPageIds.size && !policy.allowedDatabaseIds.size) return true;
  if (policy.allowedPageIds.has(page.id)) return true;
  if (page.parentType === "database" && policy.allowedDatabaseIds.has(page.parentId)) return true;
  return page.kind === "database" && policy.allowedDatabaseIds.has(page.id);
}

function filterPagesByMcpPolicy(pages, policy = configuredMcpPolicy()) {
  if (!Array.isArray(pages)) return [];
  if (!policy.allowedPageIds.size && !policy.allowedDatabaseIds.size) return pages;
  return pages.filter((page) => pageMatchesMcpPolicy(page, policy));
}

function filterBlocksByMcpPolicy(blocks, policy = configuredMcpPolicy()) {
  if (!Array.isArray(blocks)) return [];
  if (!policy.allowedPageIds.size && !policy.allowedDatabaseIds.size) return blocks;
  return blocks.filter((block) =>
    typeof block?.pageId === "string" &&
      (policy.allowedPageIds.has(block.pageId) || policy.allowedDatabaseIds.has(block.pageId))
  );
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any }} [options]
 */
function assertMcpAccessPolicy(path, { method = "GET", body } = {}) {
  const policy = configuredMcpPolicy();
  if (policy.readOnly && !isReadOnlyAllowedOperation(path, method, body)) {
    throw new Error("MCP access policy is read-only for this client.");
  }

  const ids = collectPolicyIds(path, body);
  assertAllowedIds("workspace", ids.workspaceIds, policy.allowedWorkspaceIds);
  assertAllowedPageResourceIds(ids.pageIds, policy);
  assertAllowedDatabaseResourceIds(ids.databaseIds, policy);
  assertAllowedScopes(path, body, policy);

  if (policy.allowedWorkspaceIds.size && path === "/functions/workspace-mutation") {
    const action = actionOf(body);
    if (["createWorkspace", "acceptInvitation"].includes(action)) {
      throw new Error(
        `MCP access policy denied ${action}. New workspace access cannot be pre-authorized by the workspace allowlist.`,
      );
    }
  }
}

function shouldRecordMcpAudit(path, method, body) {
  if (path === "/functions/workspace-mutation" && actionOf(body) === "recordMcpClientAction") return false;
  return method !== "GET" && !isReadOnlyAllowedOperation(path, method, body);
}

function inferWorkspaceId(body, result) {
  if (typeof body?.workspaceId === "string" && body.workspaceId.trim()) return body.workspaceId.trim();
  if (typeof result?.workspaceId === "string" && result.workspaceId.trim()) return result.workspaceId.trim();
  if (typeof result?.workspace?.id === "string" && result.workspace.id.trim()) return result.workspace.id.trim();
  if (typeof result?.page?.workspaceId === "string" && result.page.workspaceId.trim()) return result.page.workspaceId.trim();
  if (typeof result?.block?.workspaceId === "string" && result.block.workspaceId.trim()) return result.block.workspaceId.trim();
  if (typeof result?.database?.workspaceId === "string" && result.database.workspaceId.trim()) return result.database.workspaceId.trim();
  if (typeof result?.row?.workspaceId === "string" && result.row.workspaceId.trim()) return result.row.workspaceId.trim();
  if (typeof result?.upload?.workspaceId === "string" && result.upload.workspaceId.trim()) return result.upload.workspaceId.trim();
  if (typeof result?.job?.workspaceId === "string" && result.job.workspaceId.trim()) return result.job.workspaceId.trim();
  if (Array.isArray(result?.pages) && typeof result.pages[0]?.workspaceId === "string") return result.pages[0].workspaceId;
  return null;
}

function inferAuditTarget(path, body, result) {
  const backendAction = actionOf(body);
  if (typeof result?.page?.id === "string") return { targetType: "page", targetId: result.page.id };
  if (typeof result?.block?.id === "string") return { targetType: "block", targetId: result.block.id };
  if (typeof result?.comment?.id === "string") return { targetType: "comment", targetId: result.comment.id };
  if (typeof result?.database?.id === "string") return { targetType: "database", targetId: result.database.id };
  if (typeof result?.row?.id === "string") return { targetType: "database_row", targetId: result.row.id };
  if (typeof result?.upload?.id === "string") return { targetType: "file_upload", targetId: result.upload.id };
  if (typeof result?.job?.id === "string") return { targetType: "notion_import_job", targetId: result.job.id };
  if (typeof result?.connection?.id === "string") {
    return { targetType: "notion_import_connection", targetId: result.connection.id };
  }
  if (typeof body?.pageId === "string") return { targetType: "page", targetId: body.pageId };
  if (typeof body?.databaseId === "string") return { targetType: "database", targetId: body.databaseId };
  if (typeof body?.jobId === "string") return { targetType: "notion_import_job", targetId: body.jobId };
  if (typeof body?.connectionId === "string") return { targetType: "notion_import_connection", targetId: body.connectionId };
  return {
    targetType: path.replace(/^\/functions\//, "") || "backend_request",
    targetId: backendAction || path,
  };
}

function envToken() {
  const raw =
    process.env.NOTIONLIKE_MCP_ACCESS_TOKEN ??
    process.env.NOTIONLIKE_EDGEBASE_ACCESS_TOKEN ??
    process.env.EDGEBASE_ACCESS_TOKEN ??
    "";
  return raw.trim().replace(/^Bearer\s+/i, "");
}

function mcpAuthMode() {
  const raw = (process.env.NOTIONLIKE_MCP_AUTH_MODE ?? "auto").trim().toLowerCase();
  if (raw === "token" || raw === "anonymous" || raw === "auto") return raw;
  throw new Error("NOTIONLIKE_MCP_AUTH_MODE must be auto, token, or anonymous.");
}

function anonymousFallbackAllowed() {
  return process.env.NOTIONLIKE_MCP_ALLOW_ANONYMOUS !== "false";
}

function retryLimit() {
  const raw = Number(process.env.NOTIONLIKE_MCP_HTTP_RETRIES ?? 6);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 6;
}

function retryDelayMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.max(250, seconds * 1000));
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) return Math.min(60_000, Math.max(250, dateMs - Date.now()));
  }
  return Math.min(30_000, 1000 * (2 ** attempt));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

// Auth calls keep the read retry set: replaying an anonymous sign-in after an
// ambiguous 504 at worst orphans a throwaway anonymous user, and replaying a
// refresh lands inside the backend's rotation grace window (the previous
// refresh token still returns the current session tokens).
async function fetchEdgeBase(url, init, retryStatuses = RETRYABLE_READ_HTTP_STATUSES) {
  const maxRetries = retryLimit();
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    if (!retryStatuses.has(response.status) || attempt >= maxRetries) return response;
    await response.text().catch(() => "");
    await delay(retryDelayMs(response, attempt));
  }
}

// Refresh this long before the access token's exp so in-flight requests do not
// race the deadline (backend access-token TTL is 15m).
const TOKEN_REFRESH_LEEWAY_MS = 30_000;

/**
 * Decode a JWT's exp claim as epoch milliseconds. No signature verification —
 * this is client-side refresh scheduling only; the backend stays authoritative.
 * @param {string} jwt
 */
function jwtExpiryMs(jwt) {
  try {
    const payload = String(jwt ?? "").split(".")[1];
    if (!payload) return 0;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = Number(decoded?.exp);
    return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function tokenIsFresh() {
  if (!token) return false;
  if (tokenIsStatic) return true;
  // A token without a decodable exp cannot be scheduled proactively; rely on
  // the reactive 401 path in api() instead of refreshing on every call.
  if (!tokenExpiresAtMs) return true;
  return Date.now() < tokenExpiresAtMs - TOKEN_REFRESH_LEEWAY_MS;
}

function adoptSession(session) {
  const accessToken = session?.accessToken;
  if (!accessToken) throw new Error("no access token from sign-in");
  token = accessToken;
  tokenIsStatic = false;
  tokenExpiresAtMs = jwtExpiryMs(accessToken);
  // Refresh tokens rotate on use: always persist the newest one the backend
  // returned (refresh responses carry a NEW refresh token on normal rotation).
  // Cookie-transport deployments omit refreshToken from the body — keep the
  // previous one then, since it is still the session's current token.
  if (typeof session.refreshToken === "string" && session.refreshToken) {
    refreshToken = session.refreshToken;
  }
  return token;
}

async function anonymousSignIn() {
  const r = await fetchEdgeBase(`${BASE}/api/auth/signin/anonymous`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!r.ok) {
    // Log the backend detail server-side but do not surface it to the client —
    // fail() returns the message verbatim to the LLM caller.
    const detail = await r.text().catch(() => "");
    if (detail) console.error(`WARN anonymous sign-in failed: ${r.status}: ${detail}`);
    throw new Error(`Anonymous sign-in failed (HTTP ${r.status}).`);
  }
  refreshToken = null;
  return adoptSession(await r.json());
}

async function refreshSession() {
  // POST /api/auth/refresh with the refresh token in the JSON body (the
  // programmatic, non-cookie transport). On normal rotation the response
  // carries a NEW refreshToken; within the backend's reuse grace window it
  // returns the current one. adoptSession persists whichever came back.
  const r = await fetchEdgeBase(`${BASE}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    if (detail) console.error(`WARN token refresh failed: ${r.status}: ${detail}`);
    throw new Error(`Token refresh failed (HTTP ${r.status}).`);
  }
  return adoptSession(await r.json());
}

async function acquireToken() {
  if (tokenIsFresh()) return token;
  const configuredToken = envToken();
  if (configuredToken) {
    token = configuredToken;
    tokenIsStatic = true;
    tokenExpiresAtMs = 0;
    refreshToken = null;
    return token;
  }
  const authMode = mcpAuthMode();
  if (authMode === "token") {
    throw new Error(
      "MCP token auth is enabled but no access token was provided. " +
        "Set NOTIONLIKE_MCP_ACCESS_TOKEN to a Notionlike EdgeBase bearer token.",
    );
  }
  if (!anonymousFallbackAllowed()) {
    throw new Error(
      "MCP anonymous fallback is disabled. Set NOTIONLIKE_MCP_ACCESS_TOKEN " +
        "or allow anonymous local bootstrap explicitly.",
    );
  }
  if (refreshToken) {
    try {
      return await refreshSession();
    } catch (error) {
      // Refresh can fail permanently (expired refresh token, or reuse-revoked
      // after rotation). In anonymous mode a fresh sign-in — a NEW anonymous
      // identity — is an acceptable fallback; log it so the identity change is
      // traceable.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN token refresh failed; signing in anonymously again: ${message}`);
      refreshToken = null;
    }
  }
  return anonymousSignIn();
}

async function ensureToken() {
  if (tokenIsFresh()) return token;
  // Single-flight: concurrent callers share one sign-in/refresh instead of
  // minting parallel sessions. Cleared on settle so a failure can be retried.
  if (!tokenPromise) {
    tokenPromise = acquireToken().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

/** Drop a cached token the backend rejected, unless another call already replaced it. */
function invalidateToken(staleToken) {
  if (token !== staleToken) return;
  token = null;
  tokenExpiresAtMs = 0;
}

/**
 * @param {string} path
 * @param {{ method?: string, body?: any, query?: Record<string, any>, audit?: boolean }} [options]
 */
async function api(path, { method = "GET", body, query, audit = true } = {}) {
  const bearer = await ensureToken();
  assertMcpAccessPolicy(path, { method, body });
  let url = `${BASE}/api${path}`;
  if (query) url += "?" + new URLSearchParams(query).toString();
  const policy = configuredMcpPolicy();
  const client = mcpClientMetadata(policy);
  // Build the request from the token value ensureToken() RETURNED (not the
  // module variable read later) so a concurrent re-auth cannot swap identities
  // mid-request.
  const requestInit = (accessToken) => {
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "X-Notionlike-Client-Source": client.source,
      "X-Notionlike-MCP-Client-ID": client.clientId,
      "X-Notionlike-MCP-Client-Name": client.clientName,
      "X-Notionlike-MCP-Read-Only": client.readOnly ? "true" : "false",
    };
    optionalClientHeader(headers, "X-Notionlike-MCP-Subject-Type", client.subjectType);
    optionalClientHeader(headers, "X-Notionlike-MCP-Subject-ID", client.subjectId);
    optionalClientHeader(headers, "X-Notionlike-MCP-Policy-Issuer", client.issuer);
    optionalClientHeader(headers, "X-Notionlike-MCP-Policy-Audience", client.audience);
    optionalClientHeader(headers, "X-Notionlike-MCP-Transport", client.transport);
    optionalClientHeader(headers, "X-Notionlike-MCP-Provisioning-ID", client.provisioningId);
    return {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    };
  };
  const retryStatuses = retryableHttpStatuses(path, method, body);
  let r = await fetchEdgeBase(url, requestInit(bearer), retryStatuses);
  if (r.status === 401) {
    await r.text().catch(() => "");
    if (tokenIsStatic) {
      // Static-token mode has nothing to refresh — fail with actionable
      // guidance instead of a raw HTTP 401.
      throw new Error(
        "EdgeBase rejected the configured MCP access token (HTTP 401) — the token has likely expired. " +
          "Provide a fresh token via NOTIONLIKE_MCP_ACCESS_TOKEN.",
      );
    }
    // Reactive re-auth: drop the rejected token, single-flight a refresh (or a
    // fresh anonymous sign-in), and retry the original request exactly once.
    invalidateToken(bearer);
    r = await fetchEdgeBase(url, requestInit(await ensureToken()), retryStatuses);
  }
  if (!r.ok) {
    // Log the raw backend body server-side for debugging, but surface only a
    // sanitized status to the client — fail() relays the message verbatim to
    // the LLM caller, so internal backend detail must not leak.
    const detail = await r.text().catch(() => "");
    if (detail) console.error(`WARN EdgeBase ${method} ${path} ${r.status}: ${detail}`);
    throw new Error(`EdgeBase request failed: ${method} ${path} (HTTP ${r.status}).`);
  }
  if (r.status === 204) return null;
  const result = await r.json();
  if (audit && shouldRecordMcpAudit(path, method, body)) {
    await recordMcpClientAction(path, method, body, result, client).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN MCP client audit failed: ${message}`);
    });
  }
  return result;
}

async function recordMcpClientAction(path, method, body, result, client) {
  const workspaceId = inferWorkspaceId(body, result);
  if (!workspaceId) return;
  const target = inferAuditTarget(path, body, result);
  await api("/functions/workspace-mutation", {
    method: "POST",
    audit: false,
    body: {
      action: "recordMcpClientAction",
      workspaceId,
      backendPath: path,
      backendAction: actionOf(body),
      method,
      targetType: target.targetType,
      targetId: target.targetId,
      client,
    },
  });
}

function rawTableUnsupported(operation, table) {
  throw new Error(
    `MCP ${operation} for table "${table}" is not routed through a Notionlike backend function yet.`,
  );
}

async function bootstrapWorkspace() {
  const res = await api("/functions/workspace-bootstrap", {
    method: "POST",
    body: {},
  });
  const workspace = res.workspace;
  const policy = configuredMcpPolicy();
  if (workspace?.id && !isAllowedBySet(workspace.id, policy.allowedWorkspaceIds)) {
    throw new Error("MCP access policy denied the bootstrapped workspace.");
  }
  bootstrappedWorkspace = workspace;
  return bootstrappedWorkspace;
}

async function ensureWorkspace() {
  if (bootstrappedWorkspace) return bootstrappedWorkspace;
  // Single-flight: concurrent first calls share one bootstrap request instead
  // of racing duplicate workspace bootstraps. Cleared on settle for retries.
  if (!workspacePromise) {
    workspacePromise = bootstrapWorkspace().finally(() => {
      workspacePromise = null;
    });
  }
  return workspacePromise;
}

export const eb = {
  mcpAccessPolicy: () => publicMcpPolicy(),
  newId: () => globalThis.crypto.randomUUID(),

  async listTable(table, query = {}) {
    if (table === "pages") {
      if (!query.workspaceId) await ensureWorkspace();
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "pages", ...query },
      });
      return filterPagesByMcpPolicy(res?.pages ?? []);
    }
    if (table === "blocks") {
      const pageId = typeof query.pageId === "string" ? query.pageId : "";
      if (!pageId) rawTableUnsupported("listTable", table);
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "blocks", pageId },
      });
      return (res.blocks ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    if (table === "comments") {
      const pageId = typeof query.pageId === "string" ? query.pageId : "";
      if (!pageId) rawTableUnsupported("listTable", table);
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "comments", pageId },
      });
      return (res.comments ?? []).sort((a, b) =>
        String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")),
      );
    }
    return rawTableUnsupported("listTable", table);
  },
  async getOne(table, id) {
    if (table === "pages") {
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "page", pageId: id },
      });
      return res?.page ?? null;
    }
    if (table === "comments") {
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "comment", commentId: id },
      });
      return res?.comment ?? null;
    }
    return rawTableUnsupported("getOne", table);
  },
  async insert(table, data) {
    if (table === "pages") {
      const res = await api("/functions/page-mutation", {
        method: "POST",
        body: { action: "create", ...data },
      });
      return res?.page ?? res;
    }
    if (table === "blocks") {
      const res = await api("/functions/block-mutation", {
        method: "POST",
        body: { action: "create", ...data },
      });
      return res?.block ?? res;
    }
    if (DATABASE_MUTATION_TABLES.has(table)) {
      const res = await api("/functions/database-mutation", {
        method: "POST",
        body: { action: "insert", table, record: data },
      });
      return res?.record ?? res;
    }
    if (table === "comments") {
      const res = await api("/functions/comment-mutation", {
        method: "POST",
        body: { action: "create", ...data },
      });
      return res?.comment ?? res;
    }
    return rawTableUnsupported("insert", table);
  },
  async update(table, id, patch, opts = {}) {
    if (table === "pages") {
      const res = await api("/functions/page-mutation", {
        method: "POST",
        body: { action: "update", id, patch },
      });
      return res?.page ?? res;
    }
    if (table === "blocks") {
      const res = await api("/functions/block-mutation", {
        method: "POST",
        body: { action: "update", id, patch, pageId: opts.pageId },
      });
      return res?.block ?? res;
    }
    if (DATABASE_MUTATION_TABLES.has(table)) {
      const res = await api("/functions/database-mutation", {
        method: "POST",
        body: { action: "update", table, id, patch, databaseId: opts.databaseId },
      });
      return res?.record ?? res;
    }
    if (table === "comments") {
      const res = await api("/functions/comment-mutation", {
        method: "POST",
        body: { action: "update", id, patch, pageId: opts.pageId },
      });
      return res?.comment ?? res;
    }
    return rawTableUnsupported("update", table);
  },
  async del(table, id, opts = {}) {
    if (table === "pages") {
      return api("/functions/page-mutation", {
        method: "POST",
        body: { action: "delete", id },
      });
    }
    if (table === "blocks") {
      return api("/functions/block-mutation", {
        method: "POST",
        body: { action: "delete", id, pageId: opts.pageId },
      });
    }
    if (DATABASE_MUTATION_TABLES.has(table)) {
      return api("/functions/database-mutation", {
        method: "POST",
        body: { action: "delete", table, id, databaseId: opts.databaseId },
      });
    }
    if (table === "comments") {
      return api("/functions/comment-mutation", {
        method: "POST",
        body: { action: "delete", id, pageId: opts.pageId },
      });
    }
    return rawTableUnsupported("delete", table);
  },
  async search(table, q) {
    if (table === "pages") {
      await ensureWorkspace();
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "searchPages", query: q },
      });
      return filterPagesByMcpPolicy(res?.pages ?? []);
    }
    if (table === "blocks") {
      const res = await api("/functions/page-query", {
        method: "POST",
        body: { action: "searchBlocks", query: q },
      });
      return filterBlocksByMcpPolicy(res?.blocks ?? []);
    }
    return rawTableUnsupported("search", table);
  },

  // ── domain helpers ──────────────────────────────────────────────
  async workspace() {
    return ensureWorkspace();
  },
  async listWorkspaces() {
    const result = await api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "list" },
    });
    const policy = configuredMcpPolicy();
    if (!policy.allowedWorkspaceIds.size || !Array.isArray(result?.workspaces)) return result;
    return {
      ...result,
      workspaces: result.workspaces.filter((workspace) =>
        typeof workspace?.id === "string" && policy.allowedWorkspaceIds.has(workspace.id),
      ),
    };
  },
  async listOrganizations() {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "listOrganizations" },
    });
  },
  async organizationDirectory(opts = {}) {
    const body = typeof opts === "string" ? { organizationId: opts } : opts;
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "organizationDirectory", ...body },
    });
  },
  async searchOrganizationPeople(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "searchOrganizationPeople", ...opts },
    });
  },
  async updateOrganizationSettings(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "updateOrganizationSettings", ...opts },
    });
  },
  async transferOrganizationOwner(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "transferOrganizationOwner", ...opts },
    });
  },
  async deactivateOrganizationMember(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "deactivateOrganizationMember", ...opts },
    });
  },
  async reactivateOrganizationMember(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "reactivateOrganizationMember", ...opts },
    });
  },
  async removeOrganizationMember(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "removeOrganizationMember", ...opts },
    });
  },
  async createOrganizationGroup(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "createOrganizationGroup", ...opts },
    });
  },
  async updateOrganizationGroup(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "updateOrganizationGroup", ...opts },
    });
  },
  async deleteOrganizationGroup(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "deleteOrganizationGroup", ...opts },
    });
  },
  async addOrganizationGroupMember(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "addOrganizationGroupMember", ...opts },
    });
  },
  async removeOrganizationGroupMember(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "removeOrganizationGroupMember", ...opts },
    });
  },
  async addOrganizationDomain(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "addOrganizationDomain", ...opts },
    });
  },
  async verifyOrganizationDomain(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "verifyOrganizationDomain", ...opts },
    });
  },
  async removeOrganizationDomain(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "removeOrganizationDomain", ...opts },
    });
  },
  async createWorkspace(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { ...opts, action: "createWorkspace" },
    });
  },
  async deleteWorkspace(workspaceId) {
    const res = await api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "deleteWorkspace", workspaceId },
    });
    if (bootstrappedWorkspace?.id === workspaceId) bootstrappedWorkspace = null;
    return res;
  },
  async workspaceMembers(workspaceId) {
    const workspace = workspaceId ? { id: workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "members", workspaceId: workspace.id },
    });
  },
  async inviteWorkspaceMember(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "inviteMember", ...opts, workspaceId: workspace.id },
    });
  },
  async acceptWorkspaceInvitation(opts = {}) {
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "acceptInvitation", ...opts },
    });
  },
  async updateMyWorkspaceProfile(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "updateMyProfile", ...opts, workspaceId: workspace.id },
    });
  },
  async updateWorkspaceMemberRole(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "updateMemberRole", ...opts, workspaceId: workspace.id },
    });
  },
  async transferWorkspaceOwner(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "transferWorkspaceOwner", ...opts, workspaceId: workspace.id },
    });
  },
  async removeWorkspaceMember(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "removeMember", ...opts, workspaceId: workspace.id },
    });
  },
  async removeWorkspaceInvitation(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/workspace-mutation", {
      method: "POST",
      body: { action: "removeInvitation", ...opts, workspaceId: workspace.id },
    });
  },
  async createDatabase(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/database-mutation", {
      method: "POST",
      body: { action: "createDatabase", ...opts, workspaceId: workspace.id },
    });
  },
  async createDatabaseRow(data) {
    return api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "create", ...data },
    });
  },
  async updateDatabaseRow(rowId, patch) {
    const res = await api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "update", id: rowId, patch },
    });
    return res?.row ?? res;
  },
  async moveDatabaseRow(rowId, targetId, side = "after") {
    return api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "move", id: rowId, targetId, side },
    });
  },
  async trashDatabaseRow(rowId) {
    return api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "trash", id: rowId },
    });
  },
  async restoreDatabaseRow(rowId) {
    return api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "restore", id: rowId },
    });
  },
  async deleteDatabaseRow(rowId) {
    return api("/functions/database-row-mutation", {
      method: "POST",
      body: { action: "delete", id: rowId },
    });
  },
  async trashPage(pageId) {
    return api("/functions/page-mutation", {
      method: "POST",
      body: { action: "trash", id: pageId },
    });
  },
  async restorePage(pageId) {
    return api("/functions/page-mutation", {
      method: "POST",
      body: { action: "restore", id: pageId },
    });
  },
  async duplicatePage(pageId, opts = {}) {
    return api("/functions/duplicate-page", {
      method: "POST",
      body: { action: "duplicate", pageId, ...opts },
    });
  },
  async pageAccess(pageId) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "get", pageId },
    });
  },
  async publicSharedPage(token) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "publicPage", token },
    });
  },
  async pageBlocks(pageId) {
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "blocks", pageId },
    });
    return (res.blocks ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  },
  async pageComments(pageId) {
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "comments", pageId },
    });
    return (res.comments ?? []).sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")));
  },
  async databaseSnapshot(databaseId) {
    return api("/functions/page-query", {
      method: "POST",
      body: { action: "database", databaseId },
    });
  },
  async pageProjection(opts = {}) {
    if (!opts.workspaceId) await ensureWorkspace();
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "pages", ...opts },
    });
    return filterPagesByMcpPolicy(res?.pages ?? []);
  },
  async searchPages(query, opts = {}) {
    if (!opts.workspaceId) await ensureWorkspace();
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "searchPages", query, ...opts },
    });
    return filterPagesByMcpPolicy(res?.pages ?? []);
  },
  async searchBlocks(query, opts = {}) {
    if (!opts.workspaceId) await ensureWorkspace();
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "searchBlocks", query, ...opts },
    });
    return filterBlocksByMcpPolicy(res?.blocks ?? []);
  },
  async databaseRows(databaseId, opts = {}) {
    const res = await api("/functions/page-query", {
      method: "POST",
      body: { action: "databaseRows", databaseId, ...opts },
    });
    const rows = res?.rows ?? [];
    if (!res?.computed) return rows;
    return rows.map((row) => ({ ...row, __computed: res.computed[row.id] ?? {} }));
  },
  async listFiles(opts = {}) {
    const res = await api("/functions/file-mutation", {
      method: "POST",
      body: { action: "list", ...opts },
    });
    return res?.uploads ?? [];
  },
  async prepareFileUpload(opts = {}) {
    return api("/functions/file-mutation", {
      method: "POST",
      body: { action: "prepareUpload", ...opts },
    });
  },
  async deleteFile(opts = {}) {
    const res = await api("/functions/file-mutation", {
      method: "POST",
      body: { action: "delete", ...opts },
    });
    return res?.upload ?? res;
  },
  async fileDownloadUrl(opts = {}) {
    return api("/functions/file-mutation", {
      method: "POST",
      body: { action: "signedUrl", ...opts },
    });
  },
  async cleanupExpiredFiles(opts = {}) {
    return api("/functions/file-mutation", {
      method: "POST",
      body: { action: "cleanupExpired", ...opts },
    });
  },
  async fileReport(opts = {}) {
    return api("/functions/file-mutation", {
      method: "POST",
      body: { action: opts.organizationId ? "organizationReport" : "report", ...opts },
    });
  },
  async listNotifications(opts = {}) {
    return api("/functions/notification-mutation", {
      method: "POST",
      body: { action: "list", ...opts },
    });
  },
  async markNotificationsRead(opts = {}) {
    return api("/functions/notification-mutation", {
      method: "POST",
      body: { action: "markRead", ...opts },
    });
  },
  async markAllNotificationsRead(opts = {}) {
    return api("/functions/notification-mutation", {
      method: "POST",
      body: { action: "markAllRead", ...opts },
    });
  },
  async importMarkdownPage(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "importMarkdownPage", ...opts, workspaceId: workspace.id },
    });
  },
  async appendMarkdownToPage(opts = {}) {
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "appendMarkdownToPage", ...opts },
    });
  },
  async replaceMarkdownPage(opts = {}) {
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "replaceMarkdownPage", ...opts },
    });
  },
  async importCsvDatabase(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "importCsvDatabase", ...opts, workspaceId: workspace.id },
    });
  },
  async beginNotionOAuthConnection(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "beginOAuthConnection", ...opts, workspaceId: workspace.id },
    });
  },
  async completeNotionOAuthConnection(opts = {}) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "completeOAuthConnection", ...opts },
    });
  },
  async createNotionImportConnection(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "createConnection", ...opts, workspaceId: workspace.id },
    });
  },
  async listNotionImportConnections(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "listConnections", ...opts, workspaceId: workspace.id },
    });
  },
  async revokeNotionImportConnection(connectionId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "revokeConnection", connectionId },
    });
  },
  async createNotionImportJob(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "create", ...opts, workspaceId: workspace.id },
    });
  },
  async listNotionImportJobs(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "list", ...opts, workspaceId: workspace.id },
    });
  },
  async getNotionImportJob(jobId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "get", jobId },
    });
  },
  async planNotionImportJob(jobId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "plan", jobId },
    });
  },
  async discoverNotionImportJob(opts = {}) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "discover", ...opts },
    });
  },
  async cancelNotionImportJob(jobId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "cancel", jobId },
    });
  },
  async applyNotionImportJob(jobId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "apply", jobId },
    });
  },
  async retryNotionImportFileCopies(jobId) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "retryFileCopies", jobId },
    });
  },
  async retryNotionImportJob(opts = {}) {
    return api("/functions/notion-import", {
      method: "POST",
      body: { action: "retry", ...opts },
    });
  },
  async exportPageMarkdown(pageId) {
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "exportPageMarkdown", pageId },
    });
  },
  async exportDatabaseCsv(databaseId) {
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "exportDatabaseCsv", databaseId },
    });
  },
  async exportWorkspaceMarkdown(opts = {}) {
    const workspace = opts.workspaceId ? { id: opts.workspaceId } : await ensureWorkspace();
    return api("/functions/import-export", {
      method: "POST",
      body: { action: "exportWorkspaceMarkdown", ...opts, workspaceId: workspace.id },
    });
  },
  async setPageWebSharing(pageId, enabled, opts = {}) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "setWebSharing", pageId, enabled, ...opts },
    });
  },
  async invitePageAccess(pageId, opts = {}) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "invite", pageId, ...opts },
    });
  },
  async updatePageAccess(permissionId, role) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "updatePermission", permissionId, role },
    });
  },
  async removePageAccess(permissionId) {
    return api("/functions/share-mutation", {
      method: "POST",
      body: { action: "removePermission", permissionId },
    });
  },
  async pages() {
    return this.pageProjection();
  },
  async allPages() {
    return this.pageProjection({ includeTrash: true });
  },
  async blocks(pageId) {
    return this.pageBlocks(pageId);
  },
  async comments(pageId) {
    return this.pageComments(pageId);
  },
  async dbProperties(databaseId) {
    const snapshot = await this.databaseSnapshot(databaseId);
    return (snapshot.properties ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  },
  async dbViews(databaseId) {
    const snapshot = await this.databaseSnapshot(databaseId);
    return (snapshot.views ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  },
  async dbTemplates(databaseId) {
    const snapshot = await this.databaseSnapshot(databaseId);
    return (snapshot.templates ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  },
  async dbRows(databaseId, opts = {}) {
    return this.databaseRows(databaseId, opts);
  },
};

// ── Markdown ⇄ blocks ─────────────────────────────────────────────
const plainSpans = (text) => (text ? [{ text }] : []);
const plain = (rich) => (rich ?? []).map((s) => s.text).join("");

function safeMentionId(value) {
  const raw = String(value ?? "").trim();
  return raw && raw.length <= 200 && /^[A-Za-z0-9._:@-]+$/.test(raw) ? raw : "";
}

function safeDateMentionValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 80) return "";
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))?)?$/.exec(raw);
  if (!match) return "";

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisText, , zoneHourText, zoneMinuteText] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return "";
  if (hourText === undefined) return raw;

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const millis = millisText === undefined ? 0 : Number(millisText);
  if (hour > 23 || minute > 59 || second > 59 || millis > 999) return "";
  if (zoneHourText !== undefined) {
    const zoneHour = Number(zoneHourText);
    const zoneMinute = Number(zoneMinuteText);
    if (zoneHour > 23 || zoneMinute > 59) return "";
  }
  return raw;
}

function safeInlineUrl(url) {
  const raw = String(url ?? "").trim();
  if (!raw || /[\r\n\t<>"{}|\\^`]/.test(raw)) return "";
  return /^(https?:|mailto:|tel:|\/|#)/i.test(raw) ? raw : "";
}

function pageIdFromHref(href) {
  const raw = String(href ?? "").trim();
  if (!raw) return "";
  if (/^notionlike:\/\/page\//i.test(raw)) return safeMentionId(raw.replace(/^notionlike:\/\/page\//i, ""));
  let path = raw;
  try {
    const url = raw.startsWith("/") ? new URL(raw, "http://notionlike.local") : new URL(raw);
    path = url.pathname;
  } catch {
    path = raw.split(/[?#]/, 1)[0];
  }
  const match = path.match(/^\/p\/([^/]+)/);
  if (!match) return "";
  try {
    return safeMentionId(decodeURIComponent(match[1]));
  } catch {
    return safeMentionId(match[1]);
  }
}

function dateFromHref(href) {
  const raw = String(href ?? "").trim();
  if (!/^notionlike:\/\/date\//i.test(raw)) return "";
  const date = raw.replace(/^notionlike:\/\/date\//i, "").split(/[?#]/, 1)[0];
  try {
    return safeDateMentionValue(decodeURIComponent(date));
  } catch {
    return safeDateMentionValue(date);
  }
}

function personIdFromHref(href) {
  const raw = String(href ?? "").trim();
  if (!/^notionlike:\/\/person\//i.test(raw)) return "";
  const userId = raw.replace(/^notionlike:\/\/person\//i, "").split(/[?#]/, 1)[0];
  try {
    return safeMentionId(decodeURIComponent(userId));
  } catch {
    return safeMentionId(userId);
  }
}

function markdownHref(href) {
  return String(href ?? "").replace(/\s/g, "%20").replace(/\)/g, "%29");
}

function markdownTextLiteral(text) {
  return String(text ?? "").replace(/\\/g, "\\\\").replace(/([`*_~[\]])/g, "\\$1");
}

function markdownInlineCode(text) {
  const body = String(text ?? "").replace(/\n/g, " ");
  const longest = Math.max(0, ...Array.from(body.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(1, longest + 1));
  const padded = body.startsWith("`") || body.endsWith("`") ? ` ${body} ` : body;
  return `${fence}${padded}${fence}`;
}

function parseInlineMarkdown(text) {
  if (!text) return [];
  const out = [];
  let i = 0;
  let literal = "";

  const flushLiteral = () => {
    if (literal) {
      out.push({ text: literal });
      literal = "";
    }
  };
  const pushMarked = (marks, value) => {
    if (value) out.push({ ...marks, text: value });
  };
  const tryDelim = (open, mark) => {
    if (!text.startsWith(open, i)) return false;
    const close = text.indexOf(open, i + open.length);
    if (close < 0) return false;
    const inner = text.slice(i + open.length, close);
    if (!inner || /^\s|\s$/.test(inner)) return false;
    flushLiteral();
    if (mark === "code") {
      pushMarked({ code: true }, inner);
    } else {
      for (const span of parseInlineMarkdown(inner)) out.push({ ...span, [mark]: true });
    }
    i = close + open.length;
    return true;
  };

  while (i < text.length) {
    const ch = text[i];
    if (ch === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd > 0 && text[labelEnd + 1] === "(") {
        const urlEnd = text.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd) {
          const label = text.slice(i + 1, labelEnd);
          const rawHref = text.slice(labelEnd + 2, urlEnd).trim();
          const pageId = pageIdFromHref(rawHref);
          const date = dateFromHref(rawHref);
          const userId = personIdFromHref(rawHref);
          const href = safeInlineUrl(rawHref);
          if (label && (pageId || date || userId || href) && !/\s/.test(rawHref)) {
            flushLiteral();
            for (const span of parseInlineMarkdown(label)) {
              out.push(
                pageId
                  ? { ...span, mention: "page", pageId }
                  : date
                    ? { ...span, mention: "date", date }
                    : userId
                      ? { ...span, mention: "person", userId }
                      : { ...span, link: href }
              );
            }
            i = urlEnd + 1;
            continue;
          }
        }
      }
    }
    if (ch === "`" && tryDelim("`", "code")) continue;
    if ((ch === "*" || ch === "_") && tryDelim(ch + ch, "bold")) continue;
    if (ch === "~" && tryDelim("~~", "strikethrough")) continue;
    if ((ch === "*" || ch === "_") && tryDelim(ch, "italic")) continue;
    literal += ch;
    i++;
  }
  flushLiteral();
  return out;
}

const spans = (text) => parseInlineMarkdown(text);

function spansToMarkdown(rich) {
  if (!rich || rich.length === 0) return "";
  return rich
    .map((span) => {
      const raw = span.text ?? "";
      if (!raw) return "";
      if (span.code) return markdownInlineCode(raw);
      if (!raw.trim()) return raw;

      const leading = raw.match(/^\s*/)?.[0] ?? "";
      const trailing = raw.match(/\s*$/)?.[0] ?? "";
      let body = markdownTextLiteral(raw.slice(leading.length, raw.length - trailing.length));
      if (span.bold) body = `**${body}**`;
      if (span.italic) body = `*${body}*`;
      if (span.strikethrough) body = `~~${body}~~`;
      const date = span.mention === "date" ? safeDateMentionValue(span.date) : "";
      if (date) {
        return `${leading}[${body}](${markdownHref(`notionlike://date/${encodeURIComponent(date)}`)})${trailing}`;
      }
      const userId = span.mention === "person" ? safeMentionId(span.userId) : "";
      if (userId) {
        return `${leading}[${body}](${markdownHref(`notionlike://person/${encodeURIComponent(userId)}`)})${trailing}`;
      }
      const pageId = span.mention === "page" ? safeMentionId(span.pageId) : "";
      const href = pageId ? `/p/${encodeURIComponent(pageId)}` : safeInlineUrl(span.link);
      return href ? `${leading}[${body}](${markdownHref(href)})${trailing}` : `${leading}${body}${trailing}`;
    })
    .join("");
}

function pageWikiLink(label, pageId, fallback) {
  if (!label && !pageId) return fallback;
  const title = markdownTextLiteral(label || fallback.replace(/^\[\[|\]\]$/g, ""));
  const safePageId = safeMentionId(pageId);
  return safePageId ? `[[${title}]](${markdownHref(`/p/${encodeURIComponent(safePageId)}`)})` : `[[${title}]]`;
}

function normalizeTable(table) {
  const source = Array.isArray(table) && table.length > 0 ? table : [["", ""], ["", ""]];
  const rowCount = Math.max(2, source.length);
  const colCount = Math.max(2, ...source.map((row) => (Array.isArray(row) ? row.length : 0)));
  return Array.from({ length: rowCount }, (_, rowIndex) =>
    Array.from({ length: colCount }, (_, colIndex) => String(source[rowIndex]?.[colIndex] ?? ""))
  );
}

function escapeTableCell(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, "<br>");
}

function simpleTableToMarkdown(table) {
  const rows = normalizeTable(table);
  const header = `| ${rows[0].map(escapeTableCell).join(" | ")} |`;
  const separator = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`);
  return [header, separator, ...body].join("\n");
}

function isMarkdownTableRow(line) {
  const trimmed = (line ?? "").trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.slice(1, -1).includes("|");
}

function splitMarkdownTableRow(line) {
  return (line ?? "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n"));
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function markerIndent(line) {
  return line.match(/^(\s*):::/)?.[1];
}

function markerAtIndent(line, indent, pattern) {
  if (!line.startsWith(indent)) return false;
  return pattern.test(line.slice(indent.length).trim());
}

function stripColumnBodyIndent(line, baseIndent) {
  let rest = line;
  if (baseIndent && rest.startsWith(baseIndent)) rest = rest.slice(baseIndent.length);
  if (rest.startsWith("  ")) return rest.slice(2);
  if (rest.startsWith("\t")) return rest.slice(1);
  return rest;
}

function parseColumnsBlock(lines, startIndex) {
  const baseIndent = markerIndent(lines[startIndex]);
  if (baseIndent === undefined || !markerAtIndent(lines[startIndex], baseIndent, /^:::\s+columns$/i)) return null;

  const columns = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    if (markerAtIndent(lines[i], baseIndent, /^:::$/)) {
      i++;
      break;
    }
    if (!markerAtIndent(lines[i], baseIndent, /^:::\s+column(?:\s+\d+)?$/i)) {
      i++;
      continue;
    }

    i++;
    const body = [];
    while (i < lines.length && !markerAtIndent(lines[i], baseIndent, /^:::$/)) {
      body.push(stripColumnBodyIndent(lines[i], baseIndent));
      i++;
    }
    if (i < lines.length && markerAtIndent(lines[i], baseIndent, /^:::$/)) i++;
    columns.push({
      type: "column",
      content: { width: 1 },
      children: markdownToBlocks(body.join("\n")),
    });
  }

  if (columns.length === 0) {
    columns.push(
      { type: "column", content: { width: 0.5 }, children: [] },
      { type: "column", content: { width: 0.5 }, children: [] }
    );
  } else {
    const width = 1 / columns.length;
    for (const column of columns) column.content.width = width;
  }

  return {
    block: { type: "column_list", content: { rich: [] }, children: columns },
    nextIndex: i,
  };
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return name || parsed.hostname;
  } catch {
    return String(url ?? "").split("/").filter(Boolean).at(-1) || "Untitled";
  }
}

function countButtonTemplateBlocks(template) {
  if (!Array.isArray(template)) return 0;
  let count = 0;
  for (const item of template) {
    count += 1 + countButtonTemplateBlocks(item?.children ?? []);
  }
  return count;
}

export function blockToMarkdown(b) {
  const t = b.type === "code" ? plain(b.content?.rich) : spansToMarkdown(b.content?.rich);
  switch (b.type) {
    case "heading_1": return `# ${t}`;
    case "heading_2": return `## ${t}`;
    case "heading_3": return `### ${t}`;
    case "heading_4": return `#### ${t}`;
    case "toggle_heading_1": return `▶ # ${t}`;
    case "toggle_heading_2": return `▶ ## ${t}`;
    case "toggle_heading_3": return `▶ ### ${t}`;
    case "toggle_heading_4": return `▶ #### ${t}`;
    case "bulleted_list_item": return `- ${t}`;
    case "numbered_list_item": return `1. ${t}`;
    case "to_do": return `- [${b.content?.checked ? "x" : " "}] ${t}`;
    case "toggle": return `▶ ${t}`;
    case "quote": return `> ${t}`;
    case "callout": return `> ${b.content?.icon ?? "💡"} ${t}`;
    case "equation": return `$$\n${b.content?.expression ?? t}\n$$`;
    case "code": {
      const caption = plain(b.content?.caption).trim();
      const fence = "```" + (b.content?.language ?? "") + "\n" + t + "\n```";
      return caption ? `${fence}\n_${caption}_` : fence;
    }
    case "divider": return "---";
    case "simple_table": return simpleTableToMarkdown(b.content?.table);
    case "image": {
      const url = safeInlineUrl(b.content?.url);
      return url ? `![${markdownTextLiteral(plain(b.content?.caption))}](${markdownHref(url)})` : "";
    }
    case "video": {
      const url = safeInlineUrl(b.content?.url);
      return url ? `[Video](${markdownHref(url)})` : "[Video]";
    }
    case "audio": {
      const url = safeInlineUrl(b.content?.url);
      return url ? `[Audio](${markdownHref(url)})` : "[Audio]";
    }
    case "bookmark": {
      const url = safeInlineUrl(b.content?.url);
      return url ? `[${markdownTextLiteral(url)}](${markdownHref(url)})` : "";
    }
    case "embed": {
      const url = safeInlineUrl(b.content?.url);
      return url ? `[Embed](${markdownHref(url)})` : "[Embed]";
    }
    case "file": {
      const url = safeInlineUrl(b.content?.url);
      if (!url) return "[File]";
      const name = b.content?.fileName || fileNameFromUrl(url);
      return `[File: ${markdownTextLiteral(name)}](${markdownHref(url)})`;
    }
    case "link_to_page": {
      const id = b.content?.childPageId;
      return pageWikiLink(b.plainText ?? "", id, "[[Page]]");
    }
    case "child_page":
      return pageWikiLink(b.plainText ?? "", b.content?.childPageId, "[[Page]]");
    case "child_database":
    case "inline_database":
      return pageWikiLink(b.plainText ?? "", b.content?.childPageId, "[[Database]]");
    case "breadcrumb": return "[Breadcrumb]";
    case "table_of_contents": return "[Table of contents]";
    case "synced_block": {
      const id = safeMentionId(b.content?.syncedBlockId);
      return id ? `[Synced block](notionlike://block/${id})` : "[Synced block]";
    }
    case "button": {
      const label = b.content?.buttonLabel || b.plainText || "Button";
      const count = countButtonTemplateBlocks(b.content?.buttonTemplate) || 1;
      const safeLabel = markdownTextLiteral(label);
      return count > 1 ? `[Button: ${safeLabel}; ${count} blocks]` : `[Button: ${safeLabel}]`;
    }
    case "tab": return "[Tabs]";
    case "column_list": return "";
    case "column": return "";
    default: return t;
  }
}

function childBlocks(blocks, parentId) {
  return blocks
    .filter((b) => (b.parentId ?? null) === parentId)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function indentMarkdown(markdown, depth) {
  const prefix = "  ".repeat(depth);
  return markdown
    .split("\n")
    .map((line) => (line ? prefix + line : line))
    .join("\n");
}

export function blocksToMarkdown(blocks, parentId = null, depth = 0) {
  const out = [];
  for (const block of childBlocks(blocks, parentId)) {
    if (block.type === "column_list") {
      const columns = childBlocks(blocks, block.id).filter((child) => child.type === "column");
      if (columns.length === 0) continue;
      const prefix = "  ".repeat(depth);
      out.push(`${prefix}::: columns`);
      for (const [index, column] of columns.entries()) {
        out.push(`${prefix}::: column ${index + 1}`);
        const body = blocksToMarkdown(blocks, column.id, depth + 1);
        if (body) out.push(body);
        out.push(`${prefix}:::`);
      }
      out.push(`${prefix}:::`);
      continue;
    }

    if (block.type === "column") {
      const body = blocksToMarkdown(blocks, block.id, depth);
      if (body) out.push(body);
      continue;
    }

    const line = blockToMarkdown(block);
    if (line) out.push(indentMarkdown(line, depth));
    const children = blocksToMarkdown(blocks, block.id, depth + 1);
    if (children) out.push(children);
  }
  return out.join("\n");
}

/** Parse a markdown string into block records (without ids/positions). */
export function markdownToBlocks(md) {
  const lines = (md ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  // Indent-aware nesting: blocksToMarkdown emits children with 2 spaces per
  // level (see indentMarkdown), so mirror that here. `emit` attaches a block to
  // the most recent ancestor one level up (as a `children` array, the shape
  // insertMarkdownBlocks consumes) so nested list/toggle items round-trip
  // instead of collapsing into literal "  - child" paragraph text.
  const stack = [];
  let currentDepth = 0;
  const emit = (block) => {
    const parent = currentDepth > 0 ? stack[currentDepth - 1] : null;
    if (parent) {
      (parent.children ??= []).push(block);
      stack.length = currentDepth + 1;
      stack[currentDepth] = block;
    } else {
      blocks[blocks.length] = block;
      stack.length = 1;
      stack[0] = block;
    }
    return block;
  };
  let i = 0;
  while (i < lines.length) {
    // Multi-line constructs below run at the document root; the single-line
    // section recomputes this from leading indentation.
    currentDepth = 0;
    const line = lines[i];
    const columnsBlock = parseColumnsBlock(lines, i);
    if (columnsBlock) {
      emit(columnsBlock.block);
      i = columnsBlock.nextIndex;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      const code = [];
      i++;
      // Close only on a bare ``` line so fenced content with stray backticks survives.
      while (i < lines.length && lines[i].trim() !== "```") code.push(lines[i++]);
      i++; // skip the closing fence if present
      emit({
        type: "code",
        content: { rich: plainSpans(code.join("\n")), language: language || undefined },
      });
      continue;
    }
    if (line.trim() === "$$") {
      const equation = [];
      i++;
      while (i < lines.length && lines[i].trim() !== "$$") equation.push(lines[i++]);
      i++;
      const expression = equation.join("\n").trim();
      emit({
        type: "equation",
        content: { expression },
        plainText: expression,
      });
      continue;
    }
    if (/^\$\$(.+)\$\$$/.test(line.trim())) {
      const expression = line.trim().replace(/^\$\$/, "").replace(/\$\$$/, "").trim();
      emit({
        type: "equation",
        content: { expression },
        plainText: expression,
      });
      i++;
      continue;
    }
    if (isMarkdownTableRow(line) && isMarkdownTableSeparator(lines[i + 1] ?? "")) {
      const table = [splitMarkdownTableRow(line)];
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i])) {
        table.push(splitMarkdownTableRow(lines[i]));
        i++;
      }
      emit({
        type: "simple_table",
        content: { table: normalizeTable(table), headerRow: true, headerColumn: false },
      });
      continue;
    }
    i++;
    // Derive nesting depth from leading indentation (2 spaces per level, the
    // scheme blocksToMarkdown emits) and strip it before classifying the line.
    const indent = /^ */.exec(line)[0].length;
    currentDepth = Math.floor(indent / 2);
    const trimmed = line.trim();
    if (trimmed === "") {
      // skip blank lines (don't create empty paragraphs for every gap)
      continue;
    }
    if (trimmed === "---" || trimmed === "***") {
      emit({ type: "divider", content: { rich: [] } });
    } else if (/^\[video\]\((.+)\)$/i.test(trimmed)) {
      const url = trimmed.match(/^\[video\]\((.+)\)$/i)?.[1] ?? "";
      emit({ type: "video", content: { url }, plainText: url });
    } else if (/^\[audio\]\((.+)\)$/i.test(trimmed)) {
      const url = trimmed.match(/^\[audio\]\((.+)\)$/i)?.[1] ?? "";
      emit({ type: "audio", content: { url }, plainText: url });
    } else if (/^\[embed\]\((.+)\)$/i.test(trimmed)) {
      const url = trimmed.match(/^\[embed\]\((.+)\)$/i)?.[1] ?? "";
      emit({ type: "embed", content: { url }, plainText: url });
    } else if (/^\[file(?::\s*([^\]]+))?\]\((.+)\)$/i.test(trimmed)) {
      const match = trimmed.match(/^\[file(?::\s*([^\]]+))?\]\((.+)\)$/i);
      const fileName = match?.[1]?.trim() || fileNameFromUrl(match?.[2] ?? "");
      const url = match?.[2] ?? "";
      emit({ type: "file", content: { url, fileName }, plainText: fileName });
    } else if (/^\[\[(.+)\]\]\((.+)\)$/.test(trimmed)) {
      const match = trimmed.match(/^\[\[(.+)\]\]\((.+)\)$/);
      const label = match?.[1]?.trim() || "Link to page";
      const id = pageIdFromHref(match?.[2] ?? "");
      emit({ type: "link_to_page", content: id ? { rich: [], childPageId: id } : { rich: [] }, plainText: label });
    } else if (/^\[\[(.+)\]\]$/.test(trimmed)) {
      const label = trimmed.match(/^\[\[(.+)\]\]$/)?.[1]?.trim() || "Link to page";
      emit({ type: "link_to_page", content: { rich: [] }, plainText: label });
    } else if (/^\[[^\]]+\]\(notionlike:\/\/page\/([^)]+)\)$/i.test(trimmed)) {
      const match = trimmed.match(/^\[([^\]]+)\]\(notionlike:\/\/page\/([^)]+)\)$/i);
      const label = match?.[1]?.trim() || "Link to page";
      const id = match?.[2] ?? "";
      emit({ type: "link_to_page", content: { childPageId: id }, plainText: label });
    } else if (/^\[link to page\]$/i.test(trimmed)) {
      emit({ type: "link_to_page", content: { rich: [] } });
    } else if (/^\[breadcrumb\]$/i.test(trimmed)) {
      emit({ type: "breadcrumb", content: { rich: [] } });
    } else if (/^\[synced block\](?:\(notionlike:\/\/block\/([^)]+)\))?$/i.test(trimmed)) {
      const id = trimmed.match(/^\[synced block\](?:\(notionlike:\/\/block\/([^)]+)\))?$/i)?.[1];
      emit({
        type: "synced_block",
        content: id ? { rich: [], syncedBlockId: id } : { rich: [] },
        plainText: "Synced block",
      });
    } else if (/^\[tabs\]$/i.test(trimmed)) {
      emit({ type: "tab", content: { rich: [] }, plainText: "" });
    } else if (/^\[button(?::\s*([^\];]+)(?:;\s*(\d+)\s+blocks?)?)?\]$/i.test(trimmed)) {
      const match = trimmed.match(/^\[button(?::\s*([^\];]+)(?:;\s*(\d+)\s+blocks?)?)?\]$/i);
      const label = match?.[1]?.trim() || "Button";
      const count = Math.max(1, Math.min(12, Number(match?.[2] ?? 1)));
      const buttonTemplate = Array.from({ length: count }, (_, index) => ({
        type: index === 0 ? "to_do" : "paragraph",
        content:
          index === 0
            ? { rich: spans("New task"), checked: false }
            : { rich: spans("New content") },
      }));
      emit({
        type: "button",
        content: {
          rich: [],
          buttonLabel: label,
          buttonTemplate,
        },
        plainText: label,
      });
    } else if (/^[▶▸]\s+####\s+/.test(trimmed)) {
      emit({
        type: "toggle_heading_4",
        content: { rich: spans(trimmed.replace(/^[▶▸]\s+####\s+/, "")) },
      });
    } else if (/^[▶▸]\s+###\s+/.test(trimmed)) {
      emit({
        type: "toggle_heading_3",
        content: { rich: spans(trimmed.replace(/^[▶▸]\s+###\s+/, "")) },
      });
    } else if (/^[▶▸]\s+##\s+/.test(trimmed)) {
      emit({
        type: "toggle_heading_2",
        content: { rich: spans(trimmed.replace(/^[▶▸]\s+##\s+/, "")) },
      });
    } else if (/^[▶▸]\s+#\s+/.test(trimmed)) {
      emit({
        type: "toggle_heading_1",
        content: { rich: spans(trimmed.replace(/^[▶▸]\s+#\s+/, "")) },
      });
    } else if (/^[▶▸]\s+/.test(trimmed)) {
      emit({ type: "toggle", content: { rich: spans(trimmed.replace(/^[▶▸]\s+/, "")) } });
    } else if (/^####\s+/.test(trimmed)) {
      emit({ type: "heading_4", content: { rich: spans(trimmed.replace(/^####\s+/, "")) } });
    } else if (/^###\s+/.test(trimmed)) {
      emit({ type: "heading_3", content: { rich: spans(trimmed.replace(/^###\s+/, "")) } });
    } else if (/^##\s+/.test(trimmed)) {
      emit({ type: "heading_2", content: { rich: spans(trimmed.replace(/^##\s+/, "")) } });
    } else if (/^#\s+/.test(trimmed)) {
      emit({ type: "heading_1", content: { rich: spans(trimmed.replace(/^#\s+/, "")) } });
    } else if (/^[-*]\s+\[[ xX]\]\s+/.test(trimmed)) {
      const checked = /\[[xX]\]/.test(trimmed);
      emit({
        type: "to_do",
        content: { rich: spans(trimmed.replace(/^[-*]\s+\[[ xX]\]\s+/, "")), checked },
      });
    } else if (/^[-*]\s+/.test(trimmed)) {
      emit({ type: "bulleted_list_item", content: { rich: spans(trimmed.replace(/^[-*]\s+/, "")) } });
    } else if (/^\d+\.\s+/.test(trimmed)) {
      emit({ type: "numbered_list_item", content: { rich: spans(trimmed.replace(/^\d+\.\s+/, "")) } });
    } else if (/^>\s+/.test(trimmed)) {
      const value = trimmed.replace(/^>\s+/, "");
      const callout = value.match(/^(\p{Extended_Pictographic}|\p{Emoji_Presentation})\s+(.+)$/u);
      if (callout) {
        emit({ type: "callout", content: { rich: spans(callout[2]), icon: callout[1] } });
      } else {
        emit({ type: "quote", content: { rich: spans(value) } });
      }
    } else {
      emit({ type: "paragraph", content: { rich: spans(trimmed) } });
    }
  }
  return blocks;
}

export { plain as spansToPlain };
