#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "src/index.mjs");
const requiredTools = [
  "get_workspace",
  "get_mcp_access_policy",
  "_search",
  "_fetch",
  "_notion_create_pages",
  "_notion_create_database",
  "_notion_update_data_source",
  "_notion_query_data_sources",
  "_notion_create_view",
  "_notion_update_page",
  "_notion_get_users",
  "_notion_get_teams",
  "_notion_query_meeting_notes",
  "_notion_get_comments",
  "_notion_create_comment",
  "_notion_duplicate_page",
  "_notion_move_pages",
  "_notion_update_view",
  "search",
  "fetch",
  "create_pages",
  "get_users",
  "get_comments",
  "create_comment",
  "move_pages",
  "update_view",
  "list_workspaces",
  "list_organizations",
  "get_organization_directory",
  "search_organization_people",
  "update_organization_settings",
  "transfer_organization_owner",
  "deactivate_organization_member",
  "reactivate_organization_member",
  "remove_organization_member",
  "create_organization_group",
  "update_organization_group",
  "delete_organization_group",
  "add_organization_group_member",
  "remove_organization_group_member",
  "add_organization_domain",
  "verify_organization_domain",
  "remove_organization_domain",
  "create_workspace",
  "delete_workspace",
  "list_workspace_members",
  "invite_workspace_member",
  "accept_workspace_invitation",
  "update_my_workspace_profile",
  "revoke_workspace_invitation",
  "update_workspace_member_role",
  "transfer_workspace_owner",
  "remove_workspace_member",
  "search_pages",
  "search_blocks",
  "get_page",
  "list_pages",
  "import_markdown_page",
  "import_csv_database",
  "begin_notion_oauth_connection",
  "complete_notion_oauth_connection",
  "create_notion_import_connection",
  "list_notion_import_connections",
  "revoke_notion_import_connection",
  "create_notion_import_job",
  "list_notion_import_jobs",
  "get_notion_import_job",
  "plan_notion_import_job",
  "discover_notion_import_job",
  "cancel_notion_import_job",
  "apply_notion_import_job",
  "retry_notion_import_file_copies",
  "retry_notion_import_job",
  "export_page_markdown",
  "export_database_csv",
  "export_workspace_markdown",
  "create_page",
  "list_page_templates",
  "create_page_from_template",
  "update_page",
  "move_page",
  "duplicate_page",
  "set_page_lock",
  "set_page_favorite",
  "set_page_verification",
  "set_page_web_sharing",
  "list_page_access",
  "get_shared_page",
  "grant_page_access",
  "update_page_access",
  "revoke_page_access",
  "list_databases",
  "create_database",
  "describe_database",
  "create_database_view",
  "update_database_view",
  "delete_database_view",
  "query_database",
  "add_database_row",
  "update_database_row",
  "move_database_row",
  "trash_database_row",
  "restore_database_row",
  "delete_database_row_forever",
  "list_database_templates",
  "create_database_template",
  "get_database_template",
  "update_database_template",
  "duplicate_database_template",
  "delete_database_template",
  "add_comment",
  "resolve_comment",
  "list_comments",
  "list_trash",
  "trash_page",
  "restore_page",
  "delete_page_forever",
  "add_content",
  "replace_page_content",
  "add_database_property",
  "update_database_property",
  "delete_database_property",
  "prepare_file_upload",
  "list_files",
  "delete_file",
  "cleanup_expired_files",
  "get_file_report",
  "create_file_download_url",
  "list_notifications",
  "mark_notifications_read",
  "mark_all_notifications_read",
];

function withTimeout(promise, label, ms = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  cwd: root,
  stderr: "pipe",
  env: {
    ...process.env,
    NOTIONLIKE_EDGEBASE_URL:
      process.env.NOTIONLIKE_EDGEBASE_URL ?? "http://127.0.0.1:8787",
  },
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

const client = new Client(
  { name: "notionlike-mcp-smoke", version: "0.1.0" },
  { capabilities: {} },
);

try {
  await withTimeout(client.connect(transport), "MCP connect");
  const result = await withTimeout(client.listTools(), "MCP listTools");
  const tools = result.tools ?? [];
  const toolNames = new Set(tools.map((tool) => tool.name));
  const missing = requiredTools.filter((tool) => !toolNames.has(tool));
  if (missing.length) {
    throw new Error(`Missing required MCP tools: ${missing.join(", ")}`);
  }
  const resourceResult = await withTimeout(client.listResources(), "MCP listResources");
  const resourceUris = new Set((resourceResult.resources ?? []).map((resource) => resource.uri));
  for (const uri of [
    "notion://docs/enhanced-markdown-spec",
    "notion://docs/view-dsl-spec",
    "notion://docs/mcp-compatibility-report",
  ]) {
    if (!resourceUris.has(uri)) throw new Error(`Missing required MCP resource: ${uri}`);
    const resource = await withTimeout(client.readResource({ uri }), `MCP readResource ${uri}`);
    const text = resource.contents?.[0]?.text ?? "";
    if (!String(text).includes("Hanji")) throw new Error(`Resource ${uri} did not return Hanji compatibility docs`);
  }
  const accessPolicyTool = tools.find((candidate) => candidate.name === "get_mcp_access_policy");
  for (const property of [
    "readOnly",
    "allowedWorkspaceIds",
    "allowedPageIds",
    "allowedDatabaseIds",
    "scopes",
    "policyFile",
    "clientId",
    "clientName",
    "subjectType",
    "subjectId",
    "issuer",
    "audience",
    "transport",
    "provisioningId",
    "notBefore",
    "expiresAt",
    "scopeModel",
    "notionCompatibilityNote",
  ]) {
    if (!accessPolicyTool?.outputSchema?.properties?.[property]) {
      throw new Error(`Missing ${property} output schema on get_mcp_access_policy`);
    }
  }
  const serverSource = readFileSync(serverPath, "utf8");
  if (serverSource.includes("z.any(")) {
    throw new Error("MCP server must not expose loose z.any() tool schemas");
  }
  const listWorkspacesTool = tools.find((candidate) => candidate.name === "list_workspaces");
  for (const property of ["scopeModel", "notionCompatibilityNote", "count", "workspaces"]) {
    if (!listWorkspacesTool?.outputSchema?.properties?.[property]) {
      throw new Error(`Missing ${property} output schema on list_workspaces`);
    }
  }
  if (listWorkspacesTool?.outputSchema?.properties?.workspaces?.type !== "array") {
    throw new Error("list_workspaces workspaces output schema must be an array");
  }
  const searchTool = tools.find((candidate) => candidate.name === "_search");
  const searchDescription = `${searchTool?.description ?? ""}\n${searchTool?.inputSchema?.properties?.teamspace_id?.description ?? ""}`;
  for (const phrase of ["account-scoped", "workspace_id is required", "teamspace_id"]) {
    if (!searchDescription.includes(phrase)) {
      throw new Error(`_search schema/description must explain Hanji account scope and teamspace_id alias; missing phrase: ${phrase}`);
    }
  }
  for (const toolName of [
    "_search",
    "_fetch",
    "_notion_create_pages",
    "_notion_create_database",
    "_notion_update_data_source",
    "_notion_create_view",
    "_notion_update_page",
    "_notion_get_users",
    "_notion_query_meeting_notes",
    "_notion_get_comments",
    "_notion_create_comment",
    "_notion_duplicate_page",
    "_notion_move_pages",
    "_notion_update_view",
  ]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool?.inputSchema?.properties?.workspace_id) {
      throw new Error(`Missing workspace_id input schema on ${toolName}`);
    }
  }
  const queryDataSourcesTool = tools.find((candidate) => candidate.name === "_notion_query_data_sources");
  const queryDataSourcesDescription = `${queryDataSourcesTool?.description ?? ""}\n${queryDataSourcesTool?.inputSchema?.properties?.data?.description ?? ""}`;
  if (!queryDataSourcesDescription.includes("workspace_id")) {
    throw new Error("_notion_query_data_sources must document required data.workspace_id");
  }
  const describeDatabaseTool = tools.find((candidate) => candidate.name === "describe_database");
  for (const property of ["database", "rowCount", "properties", "views", "message"]) {
    if (!describeDatabaseTool?.outputSchema?.properties?.[property]) {
      throw new Error(`Missing ${property} output schema on describe_database`);
    }
  }
  const queryDatabaseTool = tools.find((candidate) => candidate.name === "query_database");
  for (const property of ["database", "view", "totalMatching", "returned", "limit", "search", "columns", "rows", "message"]) {
    if (!queryDatabaseTool?.outputSchema?.properties?.[property]) {
      throw new Error(`Missing ${property} output schema on query_database`);
    }
  }
  if (queryDatabaseTool?.outputSchema?.properties?.rows?.type !== "array") {
    throw new Error("query_database rows output schema must be an array");
  }
  for (const toolName of ["add_database_property", "update_database_property"]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool?.inputSchema?.properties?.idPrefix) {
      throw new Error(`Missing idPrefix input schema on ${toolName}`);
    }
  }
  for (const toolName of ["create_database_view", "update_database_view"]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool?.inputSchema?.properties?.wrappedColumns) {
      throw new Error(`Missing wrappedColumns input schema on ${toolName}`);
    }
    if (!tool?.inputSchema?.properties?.tableCalculations) {
      throw new Error(`Missing tableCalculations input schema on ${toolName}`);
    }
    if (!tool?.inputSchema?.properties?.subGroupBy) {
      throw new Error(`Missing subGroupBy input schema on ${toolName}`);
    }
    if (!tool?.inputSchema?.properties?.filterGroup) {
      throw new Error(`Missing filterGroup input schema on ${toolName}`);
    }
  }
  for (const toolName of ["search_pages", "search_blocks", "list_pages", "create_page", "create_page_from_template"]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool?.inputSchema?.properties?.workspaceId) {
      throw new Error(`Missing workspaceId input schema on ${toolName}`);
    }
  }
  const createWorkspaceTool = tools.find((candidate) => candidate.name === "create_workspace");
  if (!createWorkspaceTool?.inputSchema?.properties?.organizationId) {
    throw new Error("Missing organizationId input schema on create_workspace");
  }
  const updateOrganizationSettingsTool = tools.find(
    (candidate) => candidate.name === "update_organization_settings",
  );
  if (!updateOrganizationSettingsTool?.inputSchema?.properties?.workspaceCreationPolicy) {
    throw new Error("Missing workspaceCreationPolicy input schema on update_organization_settings");
  }
  if (!updateOrganizationSettingsTool?.inputSchema?.properties?.publicWebSharing) {
    throw new Error("Missing publicWebSharing input schema on update_organization_settings");
  }
  if (!updateOrganizationSettingsTool?.inputSchema?.properties?.fileDownloads) {
    throw new Error("Missing fileDownloads input schema on update_organization_settings");
  }
  if (!updateOrganizationSettingsTool?.inputSchema?.properties?.guestAccess) {
    throw new Error("Missing guestAccess input schema on update_organization_settings");
  }
  const fileReportTool = tools.find((candidate) => candidate.name === "get_file_report");
  if (!fileReportTool?.inputSchema?.properties?.organizationId) {
    throw new Error("Missing organizationId input schema on get_file_report");
  }
  const beginNotionOAuthTool = tools.find((candidate) => candidate.name === "begin_notion_oauth_connection");
  if (!beginNotionOAuthTool?.inputSchema?.properties?.redirectUri) {
    throw new Error("Missing redirectUri input schema on begin_notion_oauth_connection");
  }
  const completeNotionOAuthTool = tools.find((candidate) => candidate.name === "complete_notion_oauth_connection");
  if (!completeNotionOAuthTool?.inputSchema?.properties?.code) {
    throw new Error("Missing code input schema on complete_notion_oauth_connection");
  }
  if (!completeNotionOAuthTool?.inputSchema?.properties?.state) {
    throw new Error("Missing state input schema on complete_notion_oauth_connection");
  }
  const createNotionImportTool = tools.find((candidate) => candidate.name === "create_notion_import_job");
  const createNotionConnectionTool = tools.find((candidate) => candidate.name === "create_notion_import_connection");
  if (!createNotionConnectionTool?.inputSchema?.properties?.notionToken) {
    throw new Error("Missing notionToken input schema on create_notion_import_connection");
  }
  if (!createNotionConnectionTool?.inputSchema?.properties?.connectionKind) {
    throw new Error("Missing connectionKind input schema on create_notion_import_connection");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.connectionId) {
    throw new Error("Missing connectionId input schema on create_notion_import_job");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.snapshotItems) {
    throw new Error("Missing snapshotItems input schema on create_notion_import_job");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.rootNotionPageIds) {
    throw new Error("Missing rootNotionPageIds input schema on create_notion_import_job");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.maxEnrichedItems) {
    throw new Error("Missing maxEnrichedItems input schema on create_notion_import_job");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.maxDataSourceQueryPages) {
    throw new Error("Missing maxDataSourceQueryPages input schema on create_notion_import_job");
  }
  if (!createNotionImportTool?.inputSchema?.properties?.copyFilesToStorage) {
    throw new Error("Missing copyFilesToStorage input schema on create_notion_import_job");
  }
  const discoverNotionImportTool = tools.find((candidate) => candidate.name === "discover_notion_import_job");
  if (!discoverNotionImportTool?.inputSchema?.properties?.connectionId) {
    throw new Error("Missing connectionId input schema on discover_notion_import_job");
  }
  if (!discoverNotionImportTool?.inputSchema?.properties?.continueFromCursor) {
    throw new Error("Missing continueFromCursor input schema on discover_notion_import_job");
  }
  const planNotionImportTool = tools.find((candidate) => candidate.name === "plan_notion_import_job");
  if (!planNotionImportTool?.inputSchema?.properties?.jobId) {
    throw new Error("Missing jobId input schema on plan_notion_import_job");
  }
  const retryNotionFileCopiesTool = tools.find((candidate) => candidate.name === "retry_notion_import_file_copies");
  if (!retryNotionFileCopiesTool?.inputSchema?.properties?.jobId) {
    throw new Error("Missing jobId input schema on retry_notion_import_file_copies");
  }
  for (const toolName of [
    "transfer_organization_owner",
    "deactivate_organization_member",
    "reactivate_organization_member",
  ]) {
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool?.inputSchema?.properties?.organizationId) {
      throw new Error(`Missing organizationId input schema on ${toolName}`);
    }
    if (!tool?.inputSchema?.properties?.organizationMemberId) {
      throw new Error(`Missing organizationMemberId input schema on ${toolName}`);
    }
  }
  console.log(`MCP smoke ok: ${toolNames.size} tools advertised`);
} catch (error) {
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
