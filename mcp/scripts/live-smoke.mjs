#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deleteSmokeAccounts,
  signInSmokeAdmin,
} from "../../scripts/lib/harness.mjs";
import { hanjiEnv, withoutHanjiProductEnv } from "../src/legacy-product-compat.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "src/index.mjs");
const baseUrl = hanjiEnv("HANJI_EDGEBASE_URL") ?? "http://127.0.0.1:8787";
const DEFAULT_TOOL_TIMEOUT_MS = positiveInteger(
  hanjiEnv("HANJI_MCP_SMOKE_TOOL_TIMEOUT_MS"),
  30_000,
);
const smokeAccounts = [];

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function withTimeout(promise, label, ms = 8000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function assertBackendReachable() {
  const response = await fetch(`${baseUrl}/api/health`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  }).catch((error) => {
    throw new Error(
      `Could not reach Hanji EdgeBase backend at ${baseUrl}. ` +
        `Start it with "npm --prefix backend run dev" first. ${error.message}`,
    );
  });
  if (!response.ok) {
    throw new Error(`Backend health check failed at ${baseUrl}: HTTP ${response.status}`);
  }
}

function textContent(result) {
  return (result.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} did not include "${expected}":\n${text}`);
  }
}

function assertPolicyStructuredContent(callResult, expected, label) {
  const policy = callResult.result?.structuredContent;
  if (!policy || typeof policy !== "object") {
    throw new Error(`${label} did not include structuredContent`);
  }
  for (const property of ["allowedWorkspaceIds", "allowedPageIds", "allowedDatabaseIds", "scopes"]) {
    if (!Array.isArray(policy[property])) {
      throw new Error(`${label} structuredContent.${property} was not an array`);
    }
  }
  for (const property of [
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
  ]) {
    if (policy[property] !== null && typeof policy[property] !== "string") {
      throw new Error(`${label} structuredContent.${property} was not null or a string`);
    }
  }
  for (const [key, value] of Object.entries(expected)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!policy[key]?.includes(item)) {
          throw new Error(`${label} structuredContent.${key} did not include ${item}`);
        }
      }
    } else if (policy[key] !== value) {
      throw new Error(`${label} structuredContent.${key} expected ${value}, got ${policy[key]}`);
    }
  }
}

function assertWorkspaceListStructuredContent(callResult, expected, label) {
  const payload = callResult.result?.structuredContent;
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} did not include structuredContent`);
  }
  if (!Array.isArray(payload.workspaces)) {
    throw new Error(`${label} structuredContent.workspaces was not an array`);
  }
  if (payload.count !== payload.workspaces.length) {
    throw new Error(`${label} structuredContent.count did not match workspaces length`);
  }
  const workspace = payload.workspaces.find((candidate) => candidate?.id === expected.id);
  if (!workspace) {
    throw new Error(`${label} structuredContent did not include workspace ${expected.id}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (workspace[key] !== value) {
      throw new Error(`${label} structuredContent workspace.${key} expected ${value}, got ${workspace[key]}`);
    }
  }
}

function assertDatabaseDescriptionStructuredContent(callResult, expected, label) {
  const payload = callResult.result?.structuredContent;
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} did not include structuredContent`);
  }
  if (payload.database?.id !== expected.databaseId) {
    throw new Error(`${label} structuredContent.database.id expected ${expected.databaseId}, got ${payload.database?.id}`);
  }
  if (!Array.isArray(payload.properties) || !Array.isArray(payload.views)) {
    throw new Error(`${label} structuredContent properties/views were not arrays`);
  }
  if (expected.propertyNames) {
    for (const name of expected.propertyNames) {
      if (!payload.properties.some((property) => property?.name === name)) {
        throw new Error(`${label} structuredContent.properties did not include ${name}`);
      }
    }
  }
  if (expected.viewName && !payload.views.some((view) => view?.name === expected.viewName)) {
    throw new Error(`${label} structuredContent.views did not include ${expected.viewName}`);
  }
  if (expected.tableCalculation) {
    const view = payload.views.find((candidate) => candidate?.name === expected.tableCalculation.viewName);
    const calculation = view?.tableCalculations?.find(
      (candidate) =>
        candidate?.propertyName === expected.tableCalculation.propertyName &&
        candidate?.calculation === expected.tableCalculation.calculation,
    );
    if (!calculation) {
      throw new Error(`${label} structuredContent did not include table calculation ${JSON.stringify(expected.tableCalculation)}`);
    }
  }
}

function assertDatabaseQueryStructuredContent(callResult, expected, label) {
  const payload = callResult.result?.structuredContent;
  if (!payload || typeof payload !== "object") {
    throw new Error(`${label} did not include structuredContent`);
  }
  if (payload.database?.id !== expected.databaseId) {
    throw new Error(`${label} structuredContent.database.id expected ${expected.databaseId}, got ${payload.database?.id}`);
  }
  if (!Array.isArray(payload.columns) || !Array.isArray(payload.rows)) {
    throw new Error(`${label} structuredContent columns/rows were not arrays`);
  }
  if (typeof payload.totalMatching !== "number" || typeof payload.returned !== "number") {
    throw new Error(`${label} structuredContent counts were not numeric`);
  }
  if (expected.viewName && payload.view?.name !== expected.viewName) {
    throw new Error(`${label} structuredContent.view.name expected ${expected.viewName}, got ${payload.view?.name}`);
  }
  if (expected.rowIds) {
    for (const id of expected.rowIds) {
      if (!payload.rows.some((row) => row?.id === id)) {
        throw new Error(`${label} structuredContent.rows did not include row ${id}`);
      }
    }
  }
  if (expected.columnNames) {
    for (const name of expected.columnNames) {
      if (!payload.columns.some((column) => column?.name === name)) {
        throw new Error(`${label} structuredContent.columns did not include ${name}`);
      }
    }
  }
  if (expected.cellTexts) {
    const cellTexts = payload.rows.flatMap((row) => row?.cells?.map((cell) => cell?.text) ?? []);
    for (const text of expected.cellTexts) {
      if (!cellTexts.includes(text)) {
        throw new Error(`${label} structuredContent cell text did not include ${text}`);
      }
    }
  }
}

function assertNotIncludes(text, unexpected, label) {
  if (text.includes(unexpected)) {
    throw new Error(`${label} unexpectedly included "${unexpected}":\n${text}`);
  }
}

function assertBefore(text, first, second, label) {
  const firstIndex = text.indexOf(first);
  const secondIndex = text.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`${label} did not include "${first}" before "${second}":\n${text}`);
  }
}

function matchRequired(text, pattern, label) {
  const match = text.match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not find ${label} in response:\n${text}`);
  }
  return match[1].trim();
}

function pageIdsFromListPages(text) {
  return [
    ...new Set(
      [...text.matchAll(/\(id:\s*([^)]+)\)/g)]
        .map((match) => match[1]?.trim())
        .filter(Boolean),
    ),
  ];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function signUpForMcp(label, email, password) {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      email,
      password,
      data: { displayName: label },
    }),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok && response.status !== 201) {
    throw new Error(`${label} signup failed at ${baseUrl}: HTTP ${response.status} ${text}`);
  }
  const accessToken = body.accessToken;
  const userId = body.user?.id ?? body.userId;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error(`${label} signup did not return an access token.`);
  }
  if (typeof userId !== "string" || !userId) {
    throw new Error(`${label} signup did not return a user id.`);
  }
  smokeAccounts.push({ token: accessToken, userId, email });
  return { accessToken, userId, email };
}

function serverEnv(auth) {
  return {
    ...withoutHanjiProductEnv(process.env),
    HANJI_EDGEBASE_URL: baseUrl,
    HANJI_MCP_AUTH_MODE: "token",
    HANJI_MCP_ACCESS_TOKEN: auth.accessToken,
    HANJI_MCP_ALLOW_ANONYMOUS: "false",
  };
}

await assertBackendReachable();
const smokeSeed = Date.now();
const smokeRunId = `${smokeSeed}-${randomUUID().slice(0, 8)}`;
let primaryAuth = null;
let transport = null;
let client = null;
let stderr = "";

const createdWorkspaceIds = [];
const createdPageIds = [];
const createdFileUploadIds = [];
const createdFileUploadTargets = new Map();
const createdPermissionIds = [];
let notificationSourceClient = null;
let notificationSourceTransport = null;
let notificationSourceStderr = "";
let policyClient = null;
let policyTransport = null;
let policyStderr = "";
let emailShareClient = null;
let emailShareTransport = null;
let emailShareStderr = "";
let emailShareAuth = null;
const notificationSourcePageIds = [];
const notificationSourcePermissionIds = [];
const tempPolicyFiles = [];

function relativeIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function callTool(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }),
    `MCP ${name}`,
    timeoutMs,
  );
  const text = textContent(result);
  if (result.isError) {
    throw new Error(`${name} returned an MCP error${text ? `:\n${text}` : ""}`);
  }
  return text;
}

async function callToolResult(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const result = await withTimeout(
    client.callTool({ name, arguments: args }),
    `MCP ${name}`,
    timeoutMs,
  );
  return { result, text: textContent(result) };
}

function isAccessDenial(text) {
  return ["Forbidden", "access required", "edit access", "HTTP 403", "HTTP 404"]
    .some((marker) => text.includes(marker));
}

function assertAccessDenial(text, label) {
  if (!isAccessDenial(text)) {
    throw new Error(`${label} returned an unexpected error:\n${text}`);
  }
}

async function assertWorkspaceAdminToolsDenied(callToolResultFn, workspaceId, label, memberEmail) {
  const membersAttempt = await callToolResultFn("list_workspace_members", { workspaceId });
  if (!membersAttempt.result.isError) {
    throw new Error(`${label} list_workspace_members unexpectedly succeeded:\n${membersAttempt.text}`);
  }
  if (!isAccessDenial(membersAttempt.text)) {
    throw new Error(`${label} list_workspace_members denial returned an unexpected error:\n${membersAttempt.text}`);
  }

  const addMemberAttempt = await callToolResultFn("add_workspace_member", {
    workspaceId,
    email: memberEmail,
    role: "guest",
  });
  if (!addMemberAttempt.result.isError) {
    throw new Error(`${label} add_workspace_member unexpectedly succeeded:\n${addMemberAttempt.text}`);
  }
  if (!isAccessDenial(addMemberAttempt.text)) {
    throw new Error(`${label} add_workspace_member denial returned an unexpected error:\n${addMemberAttempt.text}`);
  }
}

async function callBackendFunction(name, body = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/functions/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${primaryAuth.accessToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${text}`);
  }
  return json;
}

async function startNotificationSourceClient() {
  const seed = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const auth = await signUpForMcp(
    "notification source MCP user",
    `mcp-live-source-${seed}@example.com`,
    `McpLiveSource${Date.now()}!aA1`,
  );
  notificationSourceTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
    env: serverEnv(auth),
  });

  notificationSourceTransport.stderr?.on("data", (chunk) => {
    notificationSourceStderr += chunk.toString();
  });

  notificationSourceClient = new Client(
    { name: "hanji-mcp-live-smoke-notification-source", version: "0.1.0" },
    { capabilities: {} },
  );
  await withTimeout(notificationSourceClient.connect(notificationSourceTransport), "MCP notification source connect");
  return auth;
}

async function callNotificationSourceTool(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  if (!notificationSourceClient) throw new Error("notification source MCP client is not connected");
  const result = await withTimeout(
    notificationSourceClient.callTool({ name, arguments: args }),
    `MCP notification source ${name}`,
    timeoutMs,
  );
  const text = textContent(result);
  if (result.isError) {
    throw new Error(text || `${name} returned an MCP error`);
  }
  return text;
}

async function callNotificationSourceToolResult(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  if (!notificationSourceClient) throw new Error("notification source MCP client is not connected");
  const result = await withTimeout(
    notificationSourceClient.callTool({ name, arguments: args }),
    `MCP notification source ${name}`,
    timeoutMs,
  );
  return { result, text: textContent(result) };
}

async function startEmailShareClient(email, password) {
  emailShareAuth = await signUpForMcp("email-shared MCP user", email, password);
  emailShareTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
    env: serverEnv(emailShareAuth),
  });

  emailShareTransport.stderr?.on("data", (chunk) => {
    emailShareStderr += chunk.toString();
  });

  emailShareClient = new Client(
    { name: "hanji-mcp-live-smoke-email-share", version: "0.1.0" },
    { capabilities: {} },
  );
  await withTimeout(emailShareClient.connect(emailShareTransport), "MCP email-share connect");
}

async function callEmailShareTool(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  if (!emailShareClient) throw new Error("email-share MCP client is not connected");
  const result = await withTimeout(
    emailShareClient.callTool({ name, arguments: args }),
    `MCP email-share ${name}`,
    timeoutMs,
  );
  const text = textContent(result);
  if (result.isError) {
    throw new Error(text || `${name} returned an MCP error`);
  }
  return text;
}

async function callEmailShareToolResult(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  if (!emailShareClient) throw new Error("email-share MCP client is not connected");
  const result = await withTimeout(
    emailShareClient.callTool({ name, arguments: args }),
    `MCP email-share ${name}`,
    timeoutMs,
  );
  return { result, text: textContent(result) };
}

async function closeEmailShareClient() {
  await emailShareClient?.close().catch(() => {});
  await emailShareTransport?.close().catch(() => {});
  emailShareClient = null;
  emailShareTransport = null;
}

async function startPolicyClient(envExtra = {}) {
  policyTransport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
    env: {
      ...serverEnv(primaryAuth),
      ...envExtra,
    },
  });

  policyTransport.stderr?.on("data", (chunk) => {
    policyStderr += chunk.toString();
  });

  policyClient = new Client(
    { name: "hanji-mcp-live-smoke-policy", version: "0.1.0" },
    { capabilities: {} },
  );
  await withTimeout(policyClient.connect(policyTransport), "MCP policy client connect");
}

async function callPolicyTool(name, args = {}, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS) {
  if (!policyClient) throw new Error("policy MCP client is not connected");
  const result = await withTimeout(
    policyClient.callTool({ name, arguments: args }),
    `MCP policy ${name}`,
    timeoutMs,
  );
  return { result, text: textContent(result) };
}

async function closePolicyClient() {
  await policyClient?.close().catch(() => {});
  await policyTransport?.close().catch(() => {});
  policyClient = null;
  policyTransport = null;
}

function cleanupTempPolicyFiles() {
  for (const path of tempPolicyFiles.splice(0)) {
    rmSync(path, { force: true });
  }
}

async function cleanupCreatedPages() {
  const ids = [...new Set(createdPageIds)].reverse();
  for (const pageId of ids) {
    await callTool("trash_page", { pageId }, 12000).catch(() => {});
    await callTool("delete_page_forever", { pageId }, 12000).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN cleanup failed for page ${pageId}: ${message}`);
      process.exitCode ||= 1;
    });
  }
}

async function deleteWorkspacePages(workspaceId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const list = await callTool("list_pages", { workspaceId }, 12000);
    const pageIds = pageIdsFromListPages(list).reverse();
    if (pageIds.length === 0) return;

    for (const pageId of pageIds) {
      await callTool("trash_page", { pageId }, 12000);
      await callTool("delete_page_forever", { pageId }, 12000);
      removeTrackedPage(pageId);
    }
  }

  const remaining = await callTool("list_pages", { workspaceId }, 12000);
  throw new Error(`Workspace ${workspaceId} still has pages before delete_workspace:\n${remaining}`);
}

async function cleanupCreatedFileUploads() {
  const ids = [...new Set(createdFileUploadIds)].reverse();
  for (const uploadId of ids) {
    const target = createdFileUploadTargets.get(uploadId);
    if (target) {
      await callTool("delete_file", target, 12000).catch(() => {});
    }
  }
  createdFileUploadIds.length = 0;
  createdFileUploadTargets.clear();
}

async function cleanupCreatedPermissions() {
  const ids = [...new Set(createdPermissionIds)].reverse();
  for (const permissionId of ids) {
    await callTool("revoke_page_access", { permissionId }, 12000).catch(() => {});
  }
  createdPermissionIds.length = 0;
}

async function cleanupCreatedWorkspaces() {
  const ids = [...new Set(createdWorkspaceIds)].reverse();
  for (const workspaceId of ids) {
    await deleteWorkspacePages(workspaceId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN workspace page cleanup failed for ${workspaceId}: ${message}`);
      process.exitCode ||= 1;
    });
    await callTool("delete_workspace", { workspaceId }, 12000).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN cleanup failed for workspace ${workspaceId}: ${message}`);
      process.exitCode ||= 1;
    });
  }
  createdWorkspaceIds.length = 0;
}

async function cleanupNotificationSourcePermissions() {
  if (!notificationSourceClient) return;
  const ids = [...new Set(notificationSourcePermissionIds)].reverse();
  for (const permissionId of ids) {
    await callNotificationSourceTool("revoke_page_access", { permissionId }, 12000).catch(() => {});
  }
  notificationSourcePermissionIds.length = 0;
}

async function cleanupNotificationSourcePages() {
  if (!notificationSourceClient) return;
  const ids = [...new Set(notificationSourcePageIds)].reverse();
  for (const pageId of ids) {
    await callNotificationSourceTool("trash_page", { pageId }, 12000).catch(() => {});
    await callNotificationSourceTool("delete_page_forever", { pageId }, 12000).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`WARN notification source cleanup failed for page ${pageId}: ${message}`);
      process.exitCode ||= 1;
    });
  }
  notificationSourcePageIds.length = 0;
}

async function closeNotificationSourceClient() {
  await notificationSourceClient?.close().catch(() => {});
  await notificationSourceTransport?.close().catch(() => {});
}

function removeTrackedFileUpload(uploadId) {
  const index = createdFileUploadIds.indexOf(uploadId);
  if (index >= 0) createdFileUploadIds.splice(index, 1);
  createdFileUploadTargets.delete(uploadId);
}

function removeTrackedPermission(permissionId) {
  const index = createdPermissionIds.indexOf(permissionId);
  if (index >= 0) createdPermissionIds.splice(index, 1);
}

function removeTrackedNotificationSourcePermission(permissionId) {
  const index = notificationSourcePermissionIds.indexOf(permissionId);
  if (index >= 0) notificationSourcePermissionIds.splice(index, 1);
}

function removeTrackedPage(pageId) {
  const index = createdPageIds.indexOf(pageId);
  if (index >= 0) createdPageIds.splice(index, 1);
}

function removeTrackedWorkspace(workspaceId) {
  const index = createdWorkspaceIds.indexOf(workspaceId);
  if (index >= 0) createdWorkspaceIds.splice(index, 1);
}

async function cleanupSmokeAccounts() {
  if (smokeAccounts.length === 0) return;
  const adminToken = await signInSmokeAdmin(baseUrl, { timeoutMs: 8000 });
  await deleteSmokeAccounts(baseUrl, adminToken, smokeAccounts);
}

try {
  primaryAuth = await signUpForMcp(
    "primary MCP user",
    `mcp-live-primary-${smokeRunId}@example.com`,
    `McpLive${smokeSeed}!aA1`,
  );
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: root,
    stderr: "pipe",
    env: serverEnv(primaryAuth),
  });
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  client = new Client(
    { name: "hanji-mcp-live-smoke", version: "0.1.0" },
    { capabilities: {} },
  );
  await withTimeout(client.connect(transport), "MCP connect");
  const text = await callTool("get_workspace");
  for (const expected of ["Current fallback workspace:", "current fallback id:", "current fallback pages:"]) {
    assertIncludes(text, expected, "get_workspace response");
  }
  const workspaceId = matchRequired(text, /^current fallback id:\s*([^\s]+)/m, "workspace id");

  const suffix = smokeSeed;
  await startPolicyClient({
    HANJI_MCP_READ_ONLY: "true",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: workspaceId,
  });
  const policy = await callPolicyTool("get_mcp_access_policy");
  assertIncludes(policy.text, "readOnly: true", "get_mcp_access_policy read-only response");
  assertIncludes(policy.text, workspaceId, "get_mcp_access_policy workspace allowlist response");
  assertPolicyStructuredContent(
    policy,
    { readOnly: true, allowedWorkspaceIds: [workspaceId] },
    "get_mcp_access_policy read-only response",
  );
  const policyPages = await callPolicyTool("list_pages", { workspaceId });
  if (policyPages.result.isError) {
    throw new Error(policyPages.text || "read-only policy list_pages unexpectedly failed");
  }
  const policyWrite = await callPolicyTool("create_page", {
    workspaceId,
    title: `Read-only policy blocked ${suffix}`,
  });
  if (!policyWrite.result.isError || !policyWrite.text.includes("read-only")) {
    throw new Error(`read-only MCP policy did not block create_page:\n${policyWrite.text}`);
  }
  await closePolicyClient();

  let scopePageId = pageIdsFromListPages(policyPages.text)[0];
  if (!scopePageId) {
    const scopePageTitle = `MCP scoped consent page ${suffix}`;
    const scopePage = await callTool("create_page", {
      workspaceId,
      title: scopePageTitle,
      content: `Scoped consent page ${suffix}`,
    });
    scopePageId = matchRequired(scopePage, /\(id:\s*([^)]+)\)/, "scoped consent page id");
    createdPageIds.push(scopePageId);
  }

  const policyFilePath = join(tmpdir(), `hanji-mcp-policy-${smokeRunId}.json`);
  const deniedPolicyWorkspaceId = `workspace-denied-${smokeRunId}`;
  tempPolicyFiles.push(policyFilePath);
  writeFileSync(
    policyFilePath,
    JSON.stringify(
      {
        readOnly: true,
        allowedWorkspaceIds: [workspaceId, deniedPolicyWorkspaceId],
        scopes: ["pages"],
        clientId: `mcp-policy-file-${smokeRunId}`,
        clientName: "MCP Policy File Smoke",
        subjectType: "service_principal",
        subjectId: `svc-policy-file-${smokeRunId}`,
        issuer: "hanji-live-smoke",
        audience: "hanji-edgebase-local",
        transport: "stdio",
        provisioningId: `prov-policy-file-${smokeRunId}`,
        expiresAt: relativeIso(1),
      },
      null,
      2,
    ),
  );
  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: policyFilePath,
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: workspaceId,
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  const filePolicy = await callPolicyTool("get_mcp_access_policy");
  assertIncludes(filePolicy.text, "readOnly: true", "file get_mcp_access_policy response");
  assertIncludes(filePolicy.text, policyFilePath, "file get_mcp_access_policy response");
  assertIncludes(filePolicy.text, `mcp-policy-file-${smokeRunId}`, "file get_mcp_access_policy response");
  assertIncludes(filePolicy.text, "MCP Policy File Smoke", "file get_mcp_access_policy response");
  assertIncludes(filePolicy.text, "expiresAt:", "file get_mcp_access_policy expiration response");
  assertIncludes(filePolicy.text, workspaceId, "file get_mcp_access_policy workspace allowlist response");
  assertNotIncludes(filePolicy.text, deniedPolicyWorkspaceId, "file get_mcp_access_policy narrowed workspace response");
  assertIncludes(filePolicy.text, "scopes: pages", "file get_mcp_access_policy scopes response");
  assertIncludes(filePolicy.text, "subjectType: service_principal", "file get_mcp_access_policy subject response");
  assertIncludes(filePolicy.text, `subjectId: svc-policy-file-${smokeRunId}`, "file get_mcp_access_policy subject response");
  assertIncludes(filePolicy.text, "issuer: hanji-live-smoke", "file get_mcp_access_policy issuer response");
  assertIncludes(filePolicy.text, "audience: hanji-edgebase-local", "file get_mcp_access_policy audience response");
  assertIncludes(filePolicy.text, "transport: stdio", "file get_mcp_access_policy transport response");
  assertIncludes(filePolicy.text, `provisioningId: prov-policy-file-${smokeRunId}`, "file get_mcp_access_policy provisioning response");
  assertPolicyStructuredContent(
    filePolicy,
    {
      readOnly: true,
      allowedWorkspaceIds: [workspaceId],
      scopes: ["pages"],
      policyFile: policyFilePath,
      clientId: `mcp-policy-file-${smokeRunId}`,
      clientName: "MCP Policy File Smoke",
      subjectType: "service_principal",
      subjectId: `svc-policy-file-${smokeRunId}`,
      issuer: "hanji-live-smoke",
      audience: "hanji-edgebase-local",
      transport: "stdio",
      provisioningId: `prov-policy-file-${smokeRunId}`,
    },
    "file get_mcp_access_policy response",
  );
  const filePolicyPages = await callPolicyTool("list_pages", { workspaceId });
  if (filePolicyPages.result.isError) {
    throw new Error(filePolicyPages.text || "policy-file list_pages unexpectedly failed");
  }
  assertIncludes(filePolicyPages.text, scopePageId, "policy-file scoped list_pages response");
  const filePolicyShareRead = await callPolicyTool("list_page_access", { pageId: scopePageId });
  if (!filePolicyShareRead.result.isError || !filePolicyShareRead.text.includes("scope sharing")) {
    throw new Error(`policy-file scopes did not block list_page_access:\n${filePolicyShareRead.text}`);
  }
  const filePolicyFileRead = await callPolicyTool("get_file_report", { workspaceId });
  if (!filePolicyFileRead.result.isError || !filePolicyFileRead.text.includes("scope files")) {
    throw new Error(`policy-file scopes did not block get_file_report:\n${filePolicyFileRead.text}`);
  }
  const filePolicyWrite = await callPolicyTool("create_page", {
    workspaceId,
    title: `Policy file blocked ${suffix}`,
  });
  if (!filePolicyWrite.result.isError || !filePolicyWrite.text.includes("read-only")) {
    throw new Error(`policy-file MCP policy did not block create_page:\n${filePolicyWrite.text}`);
  }
  await closePolicyClient();

  const expiredPolicyFilePath = join(tmpdir(), `hanji-mcp-expired-policy-${smokeRunId}.json`);
  tempPolicyFiles.push(expiredPolicyFilePath);
  writeFileSync(
    expiredPolicyFilePath,
    JSON.stringify(
      {
        readOnly: true,
        allowedWorkspaceIds: [workspaceId],
        scopes: ["pages", "import_export"],
        clientId: `mcp-expired-policy-${smokeRunId}`,
        clientName: "Expired MCP Policy Smoke",
        expiresAt: relativeIso(-1),
      },
      null,
      2,
    ),
  );
  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: expiredPolicyFilePath,
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: "",
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  const expiredPolicy = await callPolicyTool("get_mcp_access_policy");
  if (!expiredPolicy.result.isError || !expiredPolicy.text.includes("expired at")) {
    throw new Error(`expired MCP policy file was not rejected:\n${expiredPolicy.text}`);
  }
  await closePolicyClient();

  const futurePolicyFilePath = join(tmpdir(), `hanji-mcp-future-policy-${smokeRunId}.json`);
  tempPolicyFiles.push(futurePolicyFilePath);
  writeFileSync(
    futurePolicyFilePath,
    JSON.stringify(
      {
        readOnly: true,
        allowedWorkspaceIds: [workspaceId],
        scopes: ["pages"],
        clientId: `mcp-future-policy-${smokeRunId}`,
        clientName: "Future MCP Policy Smoke",
        notBefore: relativeIso(1),
        expiresAt: relativeIso(2),
      },
      null,
      2,
    ),
  );
  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: futurePolicyFilePath,
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: "",
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  const futurePolicy = await callPolicyTool("get_mcp_access_policy");
  if (!futurePolicy.result.isError || !futurePolicy.text.includes("not valid until")) {
    throw new Error(`future MCP policy file was not rejected:\n${futurePolicy.text}`);
  }
  await closePolicyClient();

  const workspaces = await callTool("list_workspaces");
  assertIncludes(workspaces, workspaceId, "list_workspaces response");
  assertIncludes(workspaces, "organization id:", "list_workspaces response");

  const organizations = await callTool("list_organizations");
  assertIncludes(organizations, "# Organizations", "list_organizations response");
  assertIncludes(organizations, "organizations:", "list_organizations response");
  const organizationId = matchRequired(organizations, /id:\s*([^\s]+)/, "organization id");
  const organizationDirectory = await callTool("get_organization_directory", { organizationId });
  assertIncludes(organizationDirectory, "# Organization Directory", "get_organization_directory response");
  assertIncludes(organizationDirectory, organizationId, "get_organization_directory response");
  assertIncludes(organizationDirectory, "domains:", "get_organization_directory response");
  assertIncludes(organizationDirectory, "profiles:", "get_organization_directory response");
  assertIncludes(organizationDirectory, "## Profiles", "get_organization_directory response");
  assertIncludes(organizationDirectory, "audit events:", "get_organization_directory response");

  const servicePrincipalPolicyFilePath = join(tmpdir(), `hanji-mcp-service-principal-policy-${smokeRunId}.json`);
  tempPolicyFiles.push(servicePrincipalPolicyFilePath);
  writeFileSync(
    servicePrincipalPolicyFilePath,
    JSON.stringify(
      {
        allowedWorkspaceIds: [workspaceId],
        scopes: ["pages", "import_export"],
        clientId: `mcp-service-principal-${smokeRunId}`,
        clientName: "MCP Service Principal Smoke",
        subjectType: "service_principal",
        subjectId: `svc-mcp-${smokeRunId}`,
        issuer: "hanji-live-provisioner",
        audience: "hanji-edgebase-local",
        transport: "stdio",
        provisioningId: `provisioned-mcp-${smokeRunId}`,
        expiresAt: relativeIso(1),
      },
      null,
      2,
    ),
  );
  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: servicePrincipalPolicyFilePath,
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: "",
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  const servicePrincipalPolicy = await callPolicyTool("get_mcp_access_policy");
  assertPolicyStructuredContent(
    servicePrincipalPolicy,
    {
      readOnly: false,
      allowedWorkspaceIds: [workspaceId],
      scopes: ["pages", "import_export"],
      policyFile: servicePrincipalPolicyFilePath,
      clientId: `mcp-service-principal-${smokeRunId}`,
      clientName: "MCP Service Principal Smoke",
      subjectType: "service_principal",
      subjectId: `svc-mcp-${smokeRunId}`,
      issuer: "hanji-live-provisioner",
      audience: "hanji-edgebase-local",
      transport: "stdio",
      provisioningId: `provisioned-mcp-${smokeRunId}`,
    },
    "service-principal get_mcp_access_policy response",
  );
  const servicePrincipalPageTitle = `MCP service principal page ${suffix}`;
  const servicePrincipalPage = await callPolicyTool("create_page", {
    workspaceId,
    title: servicePrincipalPageTitle,
    content: `Created by service-principal MCP policy ${suffix}`,
  });
  if (servicePrincipalPage.result.isError) {
    throw new Error(servicePrincipalPage.text || "service-principal policy create_page unexpectedly failed");
  }
  const servicePrincipalPageId = matchRequired(
    servicePrincipalPage.text,
    /\(id:\s*([^)]+)\)/,
    "service-principal page id",
  );
  createdPageIds.push(servicePrincipalPageId);
  await closePolicyClient();

  const servicePrincipalAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "mcp.client_action",
    auditLimit: 20,
  });
  assertIncludes(servicePrincipalAudit, `client id: mcp-service-principal-${smokeRunId}`, "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "client name: MCP Service Principal Smoke", "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "subject type: service_principal", "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, `subject id: svc-mcp-${smokeRunId}`, "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "policy issuer: hanji-live-provisioner", "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "policy audience: hanji-edgebase-local", "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "transport: stdio", "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, `provisioning id: provisioned-mcp-${smokeRunId}`, "service-principal MCP audit response");
  assertIncludes(servicePrincipalAudit, "backend action: create", "service-principal MCP audit response");

  const organizationPolicyFilePath = join(tmpdir(), `hanji-mcp-organization-policy-${smokeRunId}.json`);
  tempPolicyFiles.push(organizationPolicyFilePath);
  writeFileSync(
    organizationPolicyFilePath,
    JSON.stringify(
      {
        scopes: ["organization"],
        clientId: `mcp-organization-policy-${smokeRunId}`,
        clientName: "MCP Organization Scope Smoke",
      },
      null,
      2,
    ),
  );
  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: organizationPolicyFilePath,
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: "",
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  const organizationPolicy = await callPolicyTool("get_mcp_access_policy");
  assertIncludes(organizationPolicy.text, "scopes: organization", "organization policy scopes response");
  const organizationPolicyList = await callPolicyTool("list_organizations");
  if (organizationPolicyList.result.isError) {
    throw new Error(organizationPolicyList.text || "organization-scope list_organizations unexpectedly failed");
  }
  assertIncludes(organizationPolicyList.text, organizationId, "organization-scope list_organizations response");
  const organizationPolicyWrite = await callPolicyTool("update_organization_settings", {
    organizationId,
    workspaceCreationPolicy: "members",
  });
  if (!organizationPolicyWrite.result.isError || !organizationPolicyWrite.text.includes("scope organization_admin")) {
    throw new Error(`organization scope did not block update_organization_settings:\n${organizationPolicyWrite.text}`);
  }
  await closePolicyClient();

  const organizationDomain = `mcp-live-${suffix}.example.com`;
  const addedDomain = await callTool("add_organization_domain", { organizationId, domain: organizationDomain });
  assertIncludes(addedDomain, organizationDomain, "add_organization_domain response");
  assertIncludes(addedDomain, "(pending)", "add_organization_domain response");
  assertIncludes(addedDomain, "## Audit Log", "add_organization_domain response");
  assertIncludes(addedDomain, "Organization Domain Create", "add_organization_domain response");
  const organizationDomainId = matchRequired(
    addedDomain,
    new RegExp(`- ${escapeRegExp(organizationDomain)} \\(pending\\)\\n  id:\\s*([^\\s]+)`),
    "organization domain id",
  );
  const verifiedDomain = await callTool("verify_organization_domain", {
    organizationId,
    organizationDomainId,
  });
  assertIncludes(verifiedDomain, `${organizationDomain} (verified)`, "verify_organization_domain response");
  assertIncludes(verifiedDomain, "Organization Domain Verify", "verify_organization_domain response");
  const domainSignupPolicy = await callTool("update_organization_settings", {
    organizationId,
    domainSignupPolicy: "verified_domains",
  });
  assertIncludes(domainSignupPolicy, "domain signup: verified_domains", "update_organization_settings domain signup response");
  const domainSignupPolicyRestored = await callTool("update_organization_settings", {
    organizationId,
    domainSignupPolicy: "invite_only",
  });
  assertIncludes(domainSignupPolicyRestored, "domain signup: invite_only", "update_organization_settings domain signup restore response");
  const removedDomain = await callTool("remove_organization_domain", {
    organizationId,
    organizationDomainId,
  });
  assertNotIncludes(removedDomain, `${organizationDomain} (`, "remove_organization_domain response");
  assertIncludes(removedDomain, "Organization Domain Remove", "remove_organization_domain response");

  const memberWorkspacePolicy = await callTool("update_organization_settings", {
    organizationId,
    workspaceCreationPolicy: "members",
  });
  assertIncludes(memberWorkspacePolicy, "workspace creation: members", "update_organization_settings response");
  const ownerAdminWorkspacePolicy = await callTool("update_organization_settings", {
    organizationId,
    workspaceCreationPolicy: "owners_admins",
  });
  assertIncludes(
    ownerAdminWorkspacePolicy,
    "workspace creation: owners_admins",
    "update_organization_settings restore response",
  );
  const storageLimitPolicy = await callTool("update_organization_settings", {
    organizationId,
    storageLimitBytes: 1024 * 1024,
  });
  assertIncludes(storageLimitPolicy, "storage limit: 1.00 MB", "update_organization_settings storage response");
  const storageLimitCleared = await callTool("update_organization_settings", {
    organizationId,
    storageLimitBytes: null,
  });
  assertIncludes(storageLimitCleared, "storage limit: none", "update_organization_settings storage restore response");
  const sharingPolicyOff = await callTool("update_organization_settings", {
    organizationId,
    publicWebSharing: false,
    guestAccess: false,
    fileDownloads: false,
  });
  assertIncludes(sharingPolicyOff, "sharing public web: off", "update_organization_settings sharing off response");
  assertIncludes(sharingPolicyOff, "sharing guests: off", "update_organization_settings sharing off response");
  assertIncludes(sharingPolicyOff, "sharing file downloads: off", "update_organization_settings sharing off response");
  const sharingPolicyOn = await callTool("update_organization_settings", {
    organizationId,
    publicWebSharing: true,
    guestAccess: true,
    fileDownloads: true,
  });
  assertIncludes(sharingPolicyOn, "sharing public web: on", "update_organization_settings sharing restore response");
  assertIncludes(sharingPolicyOn, "sharing guests: on", "update_organization_settings sharing restore response");
  assertIncludes(sharingPolicyOn, "sharing file downloads: on", "update_organization_settings sharing restore response");

  const workspaceName = `MCP live smoke workspace ${suffix}`;
  const workspaceDomain = `mcp-live-${suffix}`;
  const createdWorkspace = await callTool("create_workspace", {
    name: workspaceName,
    icon: "M",
    domain: workspaceDomain,
  });
  const createdWorkspaceId = matchRequired(
    createdWorkspace,
    /created workspace id:\s*([^\s]+)/,
    "created workspace id",
  );
  createdWorkspaceIds.push(createdWorkspaceId);
  assertIncludes(createdWorkspace, workspaceName, "create_workspace response");
  assertIncludes(createdWorkspace, workspaceDomain, "create_workspace response");

  const workspacesAfterCreateResult = await callToolResult("list_workspaces");
  const workspacesAfterCreate = workspacesAfterCreateResult.text;
  assertIncludes(workspacesAfterCreate, createdWorkspaceId, "list_workspaces after create response");
  assertIncludes(workspacesAfterCreate, workspaceName, "list_workspaces after create response");
  assertWorkspaceListStructuredContent(
    workspacesAfterCreateResult,
    { id: createdWorkspaceId, name: workspaceName, domain: workspaceDomain },
    "list_workspaces after create response",
  );

  const scopedPageTitle = `MCP workspace scoped page ${suffix}`;
  const scopedBlockText = `MCP workspace scoped block ${suffix}`;
  const scopedHiddenPageTitle = `MCP workspace hidden page ${suffix}`;
  const scopedHiddenBlockText = `MCP workspace hidden block ${suffix}`;
  const scopedPage = await callTool("create_page", {
    workspaceId: createdWorkspaceId,
    title: scopedPageTitle,
    content: `## Scoped workspace page\n\n- ${scopedBlockText}`,
  });
  const scopedPageId = matchRequired(scopedPage, /\(id:\s*([^)]+)\)/, "workspace-scoped page id");
  createdPageIds.push(scopedPageId);
  assertIncludes(scopedPage, scopedPageTitle, "workspace-scoped create_page response");
  const scopedHiddenPage = await callTool("create_page", {
    workspaceId: createdWorkspaceId,
    title: scopedHiddenPageTitle,
    content: `## Hidden workspace page\n\n- ${scopedHiddenBlockText}`,
  });
  const scopedHiddenPageId = matchRequired(scopedHiddenPage, /\(id:\s*([^)]+)\)/, "workspace-hidden page id");
  createdPageIds.push(scopedHiddenPageId);
  assertIncludes(scopedHiddenPage, scopedHiddenPageTitle, "workspace-hidden create_page response");

  const scopedList = await callTool("list_pages", { workspaceId: createdWorkspaceId });
  assertIncludes(scopedList, scopedPageTitle, "workspace-scoped list_pages response");
  assertIncludes(scopedList, scopedPageId, "workspace-scoped list_pages response");
  assertIncludes(scopedList, scopedHiddenPageId, "workspace-scoped list_pages sibling response");

  await startPolicyClient({
    HANJI_MCP_READ_ONLY: "true",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: createdWorkspaceId,
    HANJI_MCP_ALLOWED_PAGE_IDS: scopedPageId,
  });
  const pagePolicyList = await callPolicyTool("list_pages", { workspaceId: createdWorkspaceId });
  if (pagePolicyList.result.isError) {
    throw new Error(pagePolicyList.text || "page allowlist policy list_pages unexpectedly failed");
  }
  assertIncludes(pagePolicyList.text, scopedPageTitle, "page allowlist list_pages response");
  assertIncludes(pagePolicyList.text, scopedPageId, "page allowlist list_pages response");
  assertNotIncludes(pagePolicyList.text, scopedHiddenPageTitle, "page allowlist list_pages response");
  assertNotIncludes(pagePolicyList.text, scopedHiddenPageId, "page allowlist list_pages response");
  const pagePolicySearch = await callPolicyTool("search_pages", {
    workspaceId: createdWorkspaceId,
    query: "MCP workspace",
  });
  if (pagePolicySearch.result.isError) {
    throw new Error(pagePolicySearch.text || "page allowlist policy search_pages unexpectedly failed");
  }
  assertIncludes(pagePolicySearch.text, scopedPageId, "page allowlist search_pages response");
  assertNotIncludes(pagePolicySearch.text, scopedHiddenPageId, "page allowlist search_pages response");
  const pagePolicyBlocks = await callPolicyTool("search_blocks", {
    workspaceId: createdWorkspaceId,
    query: "workspace",
    limit: 10,
  });
  if (pagePolicyBlocks.result.isError) {
    throw new Error(pagePolicyBlocks.text || "page allowlist policy search_blocks unexpectedly failed");
  }
  assertIncludes(pagePolicyBlocks.text, scopedBlockText, "page allowlist search_blocks response");
  assertNotIncludes(pagePolicyBlocks.text, scopedHiddenBlockText, "page allowlist search_blocks response");
  const pagePolicyDeniedRead = await callPolicyTool("get_page", { pageId: scopedHiddenPageId });
  if (!pagePolicyDeniedRead.result.isError || !pagePolicyDeniedRead.text.includes("MCP access policy denied page")) {
    throw new Error(`page MCP allowlist did not block hidden get_page:\n${pagePolicyDeniedRead.text}`);
  }
  await closePolicyClient();

  const scopedPageSearch = await callTool("search_pages", {
    workspaceId: createdWorkspaceId,
    query: scopedPageTitle,
  });
  assertIncludes(scopedPageSearch, scopedPageId, "workspace-scoped search_pages response");

  const scopedBlockSearch = await callTool("search_blocks", {
    workspaceId: createdWorkspaceId,
    query: scopedBlockText,
    limit: 5,
  });
  assertIncludes(scopedBlockSearch, scopedBlockText, "workspace-scoped search_blocks response");
  assertIncludes(scopedBlockSearch, `page id: ${scopedPageId}`, "workspace-scoped search_blocks response");

  await callTool("trash_page", { pageId: scopedHiddenPageId });
  const deletedHiddenPage = await callTool("delete_page_forever", { pageId: scopedHiddenPageId });
  assertIncludes(deletedHiddenPage, scopedHiddenPageTitle, "workspace-hidden delete_page_forever response");
  removeTrackedPage(scopedHiddenPageId);
  await callTool("trash_page", { pageId: scopedPageId });
  const deletedScopedPage = await callTool("delete_page_forever", { pageId: scopedPageId });
  assertIncludes(deletedScopedPage, scopedPageTitle, "workspace-scoped delete_page_forever response");
  removeTrackedPage(scopedPageId);

  await deleteWorkspacePages(createdWorkspaceId);
  const deletedWorkspace = await callTool("delete_workspace", { workspaceId: createdWorkspaceId });
  assertIncludes(deletedWorkspace, `deleted workspace id: ${createdWorkspaceId}`, "delete_workspace response");
  assertNotIncludes(deletedWorkspace, workspaceName, "delete_workspace response");
  removeTrackedWorkspace(createdWorkspaceId);

  const workspacesAfterDelete = await callTool("list_workspaces");
  assertNotIncludes(workspacesAfterDelete, createdWorkspaceId, "list_workspaces after delete response");

  const pageTitle = `MCP live smoke page ${suffix}`;
  const pageBody =
    `## MCP live smoke\n\n` +
    `#### MCP heading four ${suffix}\n\n` +
    `▶ #### MCP tiny toggle ${suffix}\n\n` +
    `Styled **bold** and *italic* with [link](https://example.com/mcp-rich) plus [today](hanji://date/2026-06-25) and [Ada](hanji://person/user-ada) as \`code\` and ~~struck~~\n\n` +
    `- created through MCP\n` +
    `- suffix ${suffix}`;
  const createdPage = await callTool("create_page", {
    title: pageTitle,
    content: pageBody,
  });
  const pageId = matchRequired(createdPage, /\(id:\s*([^)]+)\)/, "created page id");
  createdPageIds.push(pageId);
  assertIncludes(createdPage, "added", "create_page response");

  const filteredMcpClientAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "mcp.client_action",
    auditLimit: 10,
  });
  assertIncludes(filteredMcpClientAudit, "audit action filter: mcp.client_action", "filtered MCP client audit response");
  assertIncludes(filteredMcpClientAudit, "Mcp Client Action", "filtered MCP client audit response");
  assertIncludes(filteredMcpClientAudit, "client source: mcp", "filtered MCP client audit response");
  assertIncludes(filteredMcpClientAudit, "client id: hanji-mcp", "filtered MCP client audit response");
  assertIncludes(filteredMcpClientAudit, "backend action: create", "filtered MCP client audit response");

  const page = await callTool("get_page", { pageId });
  assertIncludes(page, pageTitle, "get_page response");
  assertIncludes(page, `#### MCP heading four ${suffix}`, "get_page response");
  assertIncludes(page, `▶ #### MCP tiny toggle ${suffix}`, "get_page response");
  assertIncludes(
    page,
    "Styled **bold** and *italic* with [link](https://example.com/mcp-rich) plus [today](hanji://date/2026-06-25) and [Ada](hanji://person/user-ada) as `code` and ~~struck~~",
    "get_page response",
  );
  assertIncludes(page, "created through MCP", "get_page response");

  const unsafeMcpText = `MCP unsafe metadata ${suffix} invalid link invalid date invalid person invalid page`;
  await callBackendFunction("block-mutation", {
    action: "createMany",
    blocks: [
      {
        id: randomUUID(),
        pageId,
        parentId: null,
        type: "paragraph",
        content: {
          rich: [
            { text: `MCP unsafe metadata ${suffix} ` },
            { text: "invalid link", link: "javascript:alert(1)" },
            { text: " invalid date", mention: "date", date: "2026-02-31T29:99:99Z" },
            { text: " invalid person", mention: "person", userId: "bad user" },
            { text: " invalid page", mention: "page", pageId: "bad page id" },
          ],
        },
        plainText: unsafeMcpText,
        position: 90,
      },
    ],
  });
  const pageWithUnsafeMetadata = await callTool("get_page", { pageId });
  assertIncludes(pageWithUnsafeMetadata, unsafeMcpText, "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "javascript:alert", "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "2026-02-31T29", "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "bad user", "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "bad%20user", "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "bad page id", "get_page unsafe metadata response");
  assertNotIncludes(pageWithUnsafeMetadata, "bad%20page%20id", "get_page unsafe metadata response");

  const exportedPageWithUnsafeMetadata = await callTool("export_page_markdown", { pageId });
  assertIncludes(exportedPageWithUnsafeMetadata, unsafeMcpText, "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "javascript:alert", "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "2026-02-31T29", "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "bad user", "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "bad%20user", "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "bad page id", "export_page_markdown unsafe metadata response");
  assertNotIncludes(exportedPageWithUnsafeMetadata, "bad%20page%20id", "export_page_markdown unsafe metadata response");

  const appendedText = `MCP live smoke appended block ${suffix}`;
  const appendedContent = await callTool("add_content", {
    pageId,
    markdown: `### ${appendedText}\n\n- appended through MCP content tool`,
  });
  assertIncludes(appendedContent, "Appended", "add_content response");
  const pageAfterAppend = await callTool("get_page", { pageId });
  assertIncludes(pageAfterAppend, appendedText, "get_page after add_content response");
  assertIncludes(pageAfterAppend, "appended through MCP content tool", "get_page after add_content response");

  const replacementText = `MCP live smoke replaced content ${suffix}`;
  const replacedContent = await callTool("replace_page_content", {
    pageId,
    markdown:
      `## MCP live smoke\n\n` +
      `- created through MCP\n` +
      `- suffix ${suffix}\n\n` +
      `### ${replacementText}\n\n` +
      `> replaced through MCP content tool`,
  });
  assertIncludes(replacedContent, "Replaced content", "replace_page_content response");
  const pageAfterReplace = await callTool("get_page", { pageId });
  assertIncludes(pageAfterReplace, replacementText, "get_page after replace_page_content response");
  assertIncludes(pageAfterReplace, "replaced through MCP content tool", "get_page after replace_page_content response");
  assertNotIncludes(pageAfterReplace, appendedText, "get_page after replace_page_content response");

  const pageSearch = await callTool("search_pages", { query: pageTitle });
  assertIncludes(pageSearch, pageTitle, "search_pages response");
  assertIncludes(pageSearch, pageId, "search_pages response");

  const blockSearch = await callTool("search_blocks", { query: replacementText, limit: 5 });
  assertIncludes(blockSearch, replacementText, "search_blocks response");
  assertIncludes(blockSearch, `page id: ${pageId}`, "search_blocks response");
  assertIncludes(blockSearch, "block id:", "search_blocks response");

  const importedMarkdownTitle = `MCP live smoke imported markdown ${suffix}`;
  const importedMarkdown = await callTool("import_markdown_page", {
    parentId: pageId,
    parentType: "page",
    title: importedMarkdownTitle,
    markdown:
      `## Imported through MCP\n\n` +
      `#### MCP imported heading four ${suffix}\n` +
      `> #### MCP imported toggle heading four ${suffix}\n\n` +
      `- markdown import item ${suffix}\n` +
      `- [x] imported todo ${suffix}\n` +
      `Styled **bold** and *italic* with [link](https://example.com/mcp-import) on [today](hanji://date/2026-06-25) by [Ada](hanji://person/user-ada) as \`code\` and ~~struck~~\n\n` +
      `$$\n` +
      `x + y = z\n` +
      `$$\n\n` +
      `| Feature | Status |\n` +
      `| --- | --- |\n` +
      `| MCP import | kept |\n\n` +
      `[Button: MCP imported button]\n` +
      `[Table of contents]\n` +
      `[Breadcrumb]\n` +
      `[Synced block]\n` +
      `[Tabs]\n` +
      `  MCP imported tab ${suffix}\n` +
      `    MCP imported tab body ${suffix}`,
  });
  const importedMarkdownPageId = matchRequired(importedMarkdown, /page id:\s*([^\s]+)/, "imported markdown page id");
  createdPageIds.push(importedMarkdownPageId);
  assertIncludes(importedMarkdown, "Imported Markdown page", "import_markdown_page response");

  const exportedMarkdownPage = await callTool("export_page_markdown", {
    pageId: importedMarkdownPageId,
  });
  assertIncludes(exportedMarkdownPage, importedMarkdownTitle, "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, `#### MCP imported heading four ${suffix}`, "export_page_markdown imported page response");
  assertIncludes(
    exportedMarkdownPage,
    `> #### MCP imported toggle heading four ${suffix}`,
    "export_page_markdown imported page response",
  );
  assertIncludes(exportedMarkdownPage, "markdown import item", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "- [x] imported todo", "export_page_markdown imported page response");
  assertIncludes(
    exportedMarkdownPage,
    "Styled **bold** and *italic* with [link](https://example.com/mcp-import) on [today](hanji://date/2026-06-25) by [Ada](hanji://person/user-ada) as `code` and ~~struck~~",
    "export_page_markdown imported page response",
  );
  assertIncludes(exportedMarkdownPage, "$$\nx + y = z\n$$", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "| Feature | Status |", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "| MCP import | kept |", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "[Button: MCP imported button]", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "[Table of contents]", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "[Breadcrumb]", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "[Synced block]", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, "[Tabs]", "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, `MCP imported tab ${suffix}`, "export_page_markdown imported page response");
  assertIncludes(exportedMarkdownPage, `MCP imported tab body ${suffix}`, "export_page_markdown imported page response");

  const importedCsvTitle = `MCP live smoke imported csv ${suffix}`;
  const importedCsv = await callTool("import_csv_database", {
    title: importedCsvTitle,
    csv: [
      "Name,Score,Ready,Due",
      `Alpha ${suffix},12,true,2026-01-01`,
      `Beta ${suffix},5,false,2026-01-02`,
    ].join("\n"),
  });
  const importedCsvDatabaseId = matchRequired(importedCsv, /database id:\s*([^\s]+)/, "imported csv database id");
  createdPageIds.push(importedCsvDatabaseId);
  assertIncludes(importedCsv, "Imported CSV database", "import_csv_database response");
  assertIncludes(importedCsv, "Score", "import_csv_database response");
  assertIncludes(importedCsv, "number", "import_csv_database response");
  assertIncludes(importedCsv, "Ready", "import_csv_database response");
  assertIncludes(importedCsv, "checkbox", "import_csv_database response");

  const exportedCsvDatabase = await callTool("export_page_markdown", {
    pageId: importedCsvDatabaseId,
  });
  assertIncludes(exportedCsvDatabase, importedCsvTitle, "export_page_markdown imported database response");
  assertIncludes(exportedCsvDatabase, "| Name | Score | Ready | Due |", "export_page_markdown imported database response");
  assertIncludes(exportedCsvDatabase, `| Alpha ${suffix} | 12 | checked | 2026-01-01 |`, "export_page_markdown imported database response");

  const exportedDatabaseCsv = await callTool("export_database_csv", {
    databaseId: importedCsvDatabaseId,
  });
  assertIncludes(exportedDatabaseCsv, "Name,Score,Ready,Due", "export_database_csv response");
  assertIncludes(exportedDatabaseCsv, `Alpha ${suffix},12,true,2026-01-01`, "export_database_csv response");

  const notionSnapshotTitle = `MCP live smoke Notion snapshot ${suffix}`;
  const notionSnapshotDataSourceId = `mcp-live-ds-${suffix}`;
  const notionSnapshotRowId = `mcp-live-row-${suffix}`;
  const notionSnapshotViewId = `mcp-live-view-${suffix}`;
  const notionSnapshotJob = await callTool("create_notion_import_job", {
    workspaceId,
    connectionKind: "manual_token",
    snapshotItems: [
      {
        notionId: notionSnapshotDataSourceId,
        notionObject: "data_source",
        title: notionSnapshotTitle,
        status: "discovered",
        phase: "snapshot",
        metadata: {
          dataSourceSnapshot: {
            dataSource: {
              object: "data_source",
              id: notionSnapshotDataSourceId,
              name: notionSnapshotTitle,
              properties: {
                Name: {
                  id: `mcp-live-prop-name-${suffix}`,
                  name: "Name",
                  type: "title",
                  title: {},
                },
                Status: {
                  id: `mcp-live-prop-status-${suffix}`,
                  name: "Status",
                  type: "status",
                  status: {
                    options: [{ id: `mcp-live-status-open-${suffix}`, name: "Open", color: "green" }],
                  },
                },
                Estimate: {
                  id: `mcp-live-prop-estimate-${suffix}`,
                  name: "Estimate",
                  type: "number",
                  number: {
                    format: "number",
                  },
                },
                "Imported formula fallback": {
                  id: `mcp-live-prop-formula-fallback-${suffix}`,
                  name: "Imported formula fallback",
                  type: "formula",
                  formula: {
                    expression: 'map(prop("Name"))',
                  },
                },
              },
            },
            rowReferences: [
              {
                id: notionSnapshotRowId,
                object: "page",
                title: `MCP live imported row ${suffix}`,
                properties: {
                  Name: {
                    id: `mcp-live-prop-name-${suffix}`,
                    type: "title",
                    title: [{ plain_text: `MCP live imported row ${suffix}` }],
                  },
                  Status: {
                    id: `mcp-live-prop-status-${suffix}`,
                    type: "status",
                    status: { id: `mcp-live-status-open-${suffix}`, name: "Open", color: "green" },
                  },
                  Estimate: {
                    id: `mcp-live-prop-estimate-${suffix}`,
                    type: "number",
                    number: 13,
                  },
                  "Imported formula fallback": {
                    id: `mcp-live-prop-formula-fallback-${suffix}`,
                    type: "formula",
                    formula: {
                      type: "string",
                      string: `MCP imported fallback ${suffix}`,
                    },
                  },
                },
              },
            ],
            views: [
              {
                id: notionSnapshotViewId,
                name: "All",
                type: "table",
                sorts: [{ property: "Status", direction: "ascending" }],
                visible_properties: ["Name", "Status", "Estimate", "Imported formula fallback"],
                property_order: ["Name", "Status", "Estimate", "Imported formula fallback"],
                table_calculations: {
                  Estimate: "sum",
                },
              },
            ],
            rowsHasMore: true,
            rowsNextCursor: `mcp-live-row-cursor-${suffix}`,
            viewsHasMore: true,
            viewsNextCursor: `mcp-live-view-cursor-${suffix}`,
          },
        },
      },
    ],
  }, 20000);
  const notionSnapshotJobId = matchRequired(notionSnapshotJob, /job id:\s*([^\s]+)/, "Notion snapshot import job id");
  assertIncludes(notionSnapshotJob, "status: ready", "create_notion_import_job snapshot response");
  assertIncludes(notionSnapshotJob, notionSnapshotTitle, "create_notion_import_job snapshot response");
  assertIncludes(notionSnapshotJob, notionSnapshotDataSourceId, "create_notion_import_job snapshot response");

  const notionSnapshotJobs = await callTool("list_notion_import_jobs", { workspaceId });
  assertIncludes(notionSnapshotJobs, notionSnapshotJobId, "list_notion_import_jobs response");
  assertIncludes(notionSnapshotJobs, "status: ready", "list_notion_import_jobs response");

  const notionSnapshotRead = await callTool("get_notion_import_job", { jobId: notionSnapshotJobId });
  assertIncludes(notionSnapshotRead, notionSnapshotTitle, "get_notion_import_job response");
  assertIncludes(notionSnapshotRead, notionSnapshotRowId, "get_notion_import_job response");

  await startPolicyClient({
    HANJI_MCP_POLICY_FILE: "",
    HANJI_MCP_CONSENT_FILE: "",
    HANJI_MCP_READ_ONLY: "",
    HANJI_MCP_ALLOW_WRITES: "",
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: workspaceId,
    HANJI_MCP_ALLOWED_PAGE_IDS: "",
    HANJI_MCP_ALLOWED_DATABASE_IDS: "",
    HANJI_MCP_SCOPES: "notion_import",
    HANJI_MCP_CLIENT_ID: "",
    HANJI_MCP_CLIENT_NAME: "",
  });
  try {
    const notionImportPolicy = await callPolicyTool("get_mcp_access_policy");
    assertIncludes(notionImportPolicy.text, "scopes: notion_import", "notion import policy scopes response");
    assertPolicyStructuredContent(
      notionImportPolicy,
      { allowedWorkspaceIds: [workspaceId], scopes: ["notion_import"] },
      "notion import policy scopes response",
    );
    const scopedNotionImportJobs = await callPolicyTool("list_notion_import_jobs", { workspaceId });
    if (scopedNotionImportJobs.result.isError) {
      throw new Error(scopedNotionImportJobs.text || "notion-import-scope list_notion_import_jobs unexpectedly failed");
    }
    assertIncludes(scopedNotionImportJobs.text, notionSnapshotJobId, "notion-import-scope list_notion_import_jobs response");
    const scopedNotionImportJob = await callPolicyTool("get_notion_import_job", { jobId: notionSnapshotJobId });
    if (scopedNotionImportJob.result.isError) {
      throw new Error(scopedNotionImportJob.text || "notion-import-scope get_notion_import_job unexpectedly failed");
    }
    assertIncludes(scopedNotionImportJob.text, notionSnapshotTitle, "notion-import-scope get_notion_import_job response");
    const scopedNotionImportPlan = await callPolicyTool("plan_notion_import_job", { jobId: notionSnapshotJobId });
    if (scopedNotionImportPlan.result.isError) {
      throw new Error(scopedNotionImportPlan.text || "notion-import-scope plan_notion_import_job unexpectedly failed");
    }
    assertIncludes(scopedNotionImportPlan.text, "can apply: yes", "notion-import-scope plan_notion_import_job response");
    const scopedPages = await callPolicyTool("list_pages", { workspaceId });
    if (!scopedPages.result.isError || !scopedPages.text.includes("scope pages")) {
      throw new Error(`notion_import scope did not block list_pages:\n${scopedPages.text}`);
    }
  } finally {
    await closePolicyClient();
  }

  const notionSnapshotPlan = await callTool("plan_notion_import_job", { jobId: notionSnapshotJobId });
  assertIncludes(notionSnapshotPlan, "## Import review", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "can apply: yes", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "databases: 1", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "rows: 1", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "views: 1", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "unsupported: 1", "plan_notion_import_job response");
  assertIncludes(notionSnapshotPlan, "discovery incomplete: 2", "plan_notion_import_job response");

  const notionSnapshotApply = await callTool("apply_notion_import_job", { jobId: notionSnapshotJobId }, 20000);
  assertIncludes(notionSnapshotApply, "status: completed", "apply_notion_import_job response");
  assertIncludes(notionSnapshotApply, "phase: applied", "apply_notion_import_job response");
  assertIncludes(notionSnapshotApply, "applied databases: 1", "apply_notion_import_job response");
  assertIncludes(notionSnapshotApply, "applied rows: 1", "apply_notion_import_job response");
  assertIncludes(notionSnapshotApply, "applied properties: 4", "apply_notion_import_job response");
  assertIncludes(notionSnapshotApply, "applied views: 1", "apply_notion_import_job response");

  const filteredNotionImportMcpAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "mcp.client_action",
    auditTargetType: "notion_import_job",
    auditLimit: 20,
  });
  assertIncludes(filteredNotionImportMcpAudit, "audit action filter: mcp.client_action", "filtered Notion import MCP audit response");
  assertIncludes(filteredNotionImportMcpAudit, "audit target filter: notion_import_job", "filtered Notion import MCP audit response");
  assertIncludes(filteredNotionImportMcpAudit, `target id: ${notionSnapshotJobId}`, "filtered Notion import MCP audit response");
  assertIncludes(filteredNotionImportMcpAudit, "backend path: /functions/notion-import", "filtered Notion import MCP audit response");
  assertIncludes(filteredNotionImportMcpAudit, "backend action: plan", "filtered Notion import MCP audit response");
  assertIncludes(filteredNotionImportMcpAudit, "backend action: apply", "filtered Notion import MCP audit response");

  const notionImportRootSearch = await callTool("search_pages", {
    workspaceId,
    query: "Imported from Notion",
    limit: 10,
  });
  const notionImportRootPageId = matchRequired(
    notionImportRootSearch,
    /- Imported from Notion\s+\(id:\s*([^)]+)\)/,
    "Notion import root page id",
  );
  createdPageIds.push(notionImportRootPageId);

  const notionImportedChildren = await callTool("list_pages", {
    workspaceId,
    parentId: notionImportRootPageId,
  });
  const notionSnapshotDatabaseId = matchRequired(
    notionImportedChildren,
    new RegExp(`- ${escapeRegExp(notionSnapshotTitle)} \\[database\\].*\\(id:\\s*([^)]+)\\)`),
    "Notion snapshot imported database id",
  );
  createdPageIds.push(notionSnapshotDatabaseId);

  const notionSnapshotImportedRowsResult = await callToolResult("query_database", {
    databaseId: notionSnapshotDatabaseId,
    view: "All",
    search: `MCP live imported row ${suffix}`,
    limit: 5,
  });
  const notionSnapshotImportedRows = notionSnapshotImportedRowsResult.text;
  const notionSnapshotImportedRowId = matchRequired(
    notionSnapshotImportedRows,
    /\|\s*([^|\s][^|]*?)\s*\|\s*MCP live imported row/,
    "Notion snapshot imported row id",
  );
  createdPageIds.push(notionSnapshotImportedRowId);
  assertIncludes(notionSnapshotImportedRows, notionSnapshotTitle, "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, "view: All [table]", "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, "Open", "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, "Estimate", "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, "13", "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, "Imported formula fallback", "query_database imported Notion snapshot response");
  assertIncludes(notionSnapshotImportedRows, `MCP imported fallback ${suffix}`, "query_database imported Notion snapshot response");
  assertDatabaseQueryStructuredContent(
    notionSnapshotImportedRowsResult,
    {
      databaseId: notionSnapshotDatabaseId,
      viewName: "All",
      rowIds: [notionSnapshotImportedRowId],
      columnNames: ["Name", "Status", "Estimate", "Imported formula fallback"],
      cellTexts: [`MCP live imported row ${suffix}`, "Open", "13", `MCP imported fallback ${suffix}`],
    },
    "query_database imported Notion snapshot response",
  );

  const notionSnapshotImportedSchemaResult = await callToolResult("describe_database", {
    databaseId: notionSnapshotDatabaseId,
  });
  const notionSnapshotImportedSchema = notionSnapshotImportedSchemaResult.text;
  assertIncludes(notionSnapshotImportedSchema, "Estimate [number]", "describe_database imported Notion snapshot response");
  assertIncludes(
    notionSnapshotImportedSchema,
    "calculations: Estimate sum",
    "describe_database imported Notion snapshot response",
  );
  assertDatabaseDescriptionStructuredContent(
    notionSnapshotImportedSchemaResult,
    {
      databaseId: notionSnapshotDatabaseId,
      propertyNames: ["Name", "Status", "Estimate", "Imported formula fallback"],
      viewName: "All",
      tableCalculation: { viewName: "All", propertyName: "Estimate", calculation: "sum" },
    },
    "describe_database imported Notion snapshot response",
  );

  const exportedWorkspace = await callTool("export_workspace_markdown", {
    workspaceId,
  }, 20000);
  assertIncludes(exportedWorkspace, importedMarkdownTitle, "export_workspace_markdown response");
  assertIncludes(exportedWorkspace, importedCsvTitle, "export_workspace_markdown response");
  assertIncludes(exportedWorkspace, notionSnapshotTitle, "export_workspace_markdown response");
  assertBefore(exportedWorkspace, pageTitle, importedMarkdownTitle, "export_workspace_markdown nested page order");

  const lifecycleTitle = `MCP live smoke lifecycle ${suffix}`;
  const lifecycleCreated = await callTool("create_page", {
    title: lifecycleTitle,
    content: `Lifecycle page for ${pageTitle}`,
  });
  const lifecyclePageId = matchRequired(lifecycleCreated, /\(id:\s*([^)]+)\)/, "created lifecycle page id");
  createdPageIds.push(lifecyclePageId);

  const movedLifecycle = await callTool("move_page", {
    pageId: lifecyclePageId,
    parentId: pageId,
    parentType: "page",
  });
  assertIncludes(movedLifecycle, lifecycleTitle, "move_page response");
  assertIncludes(movedLifecycle, `page ${pageId}`, "move_page response");

  const duplicateTitle = `MCP live smoke duplicate ${suffix}`;
  const duplicatedLifecycle = await callTool("duplicate_page", {
    workspace_id: workspaceId,
    pageId: lifecyclePageId,
    title: duplicateTitle,
  });
  const duplicatedPageId = matchRequired(duplicatedLifecycle, /page id:\s*([^\s]+)/, "duplicated page id");
  createdPageIds.push(duplicatedPageId);
  assertIncludes(duplicatedLifecycle, duplicateTitle, "duplicate_page response");
  assertIncludes(duplicatedLifecycle, "copied:", "duplicate_page response");

  const trashedDuplicate = await callTool("trash_page", { pageId: duplicatedPageId });
  assertIncludes(trashedDuplicate, duplicateTitle, "trash_page response");
  assertIncludes(trashedDuplicate, "to trash", "trash_page response");

  const trashList = await callTool("list_trash");
  assertIncludes(trashList, duplicateTitle, "list_trash response");
  assertIncludes(trashList, duplicatedPageId, "list_trash response");

  const restoredDuplicate = await callTool("restore_page", { pageId: duplicatedPageId });
  assertIncludes(restoredDuplicate, duplicateTitle, "restore_page response");
  assertIncludes(restoredDuplicate, "Restored", "restore_page response");

  const retrashDuplicate = await callTool("trash_page", { pageId: duplicatedPageId });
  assertIncludes(retrashDuplicate, duplicateTitle, "trash_page before delete response");
  const deletedDuplicate = await callTool("delete_page_forever", { pageId: duplicatedPageId });
  assertIncludes(deletedDuplicate, duplicateTitle, "delete_page_forever response");
  assertIncludes(deletedDuplicate, "Deleted", "delete_page_forever response");
  removeTrackedPage(duplicatedPageId);

  const commentText = `MCP live smoke comment ${suffix}`;
  const addedComment = await callTool("add_comment", { pageId, text: commentText });
  matchRequired(addedComment, /comment id:\s*([^\s]+)/, "created comment id");

  const comments = await callTool("list_comments", { pageId, includeResolved: true });
  assertIncludes(comments, commentText, "list_comments response");

  const members = await callTool("list_workspace_members");
  const currentUserId = matchRequired(members, /user id:\s*([^\s]+)/, "current MCP user id");

  const notificationSourceSession = await startNotificationSourceClient();
  const notificationSourceMembers = await callNotificationSourceTool("list_workspace_members");
  const notificationSourceUserId = matchRequired(
    notificationSourceMembers,
    /user id:\s*([^\s]+)/,
    "notification source MCP user id",
  );
  const notificationSourceEmail = notificationSourceSession.email;

  const profileName = `MCP live smoke profile ${suffix}`;
  const profileEmail = `mcp-live-profile-${suffix}@example.com`;
  const updatedProfile = await callTool("update_my_workspace_profile", {
    workspaceId,
    displayName: profileName,
    email: profileEmail,
  });
  assertIncludes(updatedProfile, profileName, "update_my_workspace_profile response");
  assertIncludes(updatedProfile, profileEmail, "update_my_workspace_profile response");
  const peopleSearch = await callTool("search_organization_people", {
    organizationId,
    query: profileEmail,
    limit: 5,
  });
  assertIncludes(peopleSearch, "# Organization People Search", "search_organization_people response");
  assertIncludes(peopleSearch, profileEmail, "search_organization_people response");
  assertIncludes(peopleSearch, currentUserId, "search_organization_people response");

  const addedByEmail = await callTool("add_workspace_member", {
    workspaceId,
    email: notificationSourceEmail,
    displayName: "MCP live smoke existing account",
    role: "guest",
  });
  assertIncludes(addedByEmail, notificationSourceEmail, "add_workspace_member exact-email response");
  assertIncludes(addedByEmail, notificationSourceUserId, "add_workspace_member exact-email response");
  assertIncludes(addedByEmail, "Guest", "add_workspace_member exact-email response");
  const filteredMemberAddAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "workspace_member.add",
    auditLimit: 5,
  });
  assertIncludes(filteredMemberAddAudit, "audit action filter: workspace_member.add", "filtered workspace member add audit response");
  assertIncludes(filteredMemberAddAudit, "Workspace Member Add", "filtered workspace member add audit response");

  const unknownAccountEmail = `mcp-live-unknown-account-${suffix}@example.com`;
  const blindUnknownAccountAdd = await callTool("add_workspace_member", {
    workspaceId,
    email: unknownAccountEmail,
    displayName: "MCP live smoke unknown account",
    role: "member",
  });
  assertNotIncludes(blindUnknownAccountAdd, unknownAccountEmail, "add_workspace_member blind unknown-account response");
  const membersAfterBlindAdd = await callTool("list_workspace_members", { workspaceId });
  assertNotIncludes(membersAfterBlindAdd, unknownAccountEmail, "list_workspace_members after blind unknown-account add");

  const transferredWorkspaceOwner = await callTool("transfer_workspace_owner", {
    workspaceId,
    userId: notificationSourceUserId,
  });
  assertIncludes(transferredWorkspaceOwner, notificationSourceUserId, "transfer_workspace_owner response");
  assertIncludes(transferredWorkspaceOwner, "Owner", "transfer_workspace_owner response");
  assertIncludes(transferredWorkspaceOwner, currentUserId, "transfer_workspace_owner response");
  assertIncludes(transferredWorkspaceOwner, "Admin", "transfer_workspace_owner response");

  const restoredWorkspaceOwner = await callNotificationSourceTool("transfer_workspace_owner", {
    workspaceId,
    userId: currentUserId,
  });
  assertIncludes(restoredWorkspaceOwner, currentUserId, "transfer_workspace_owner restore response");
  assertIncludes(restoredWorkspaceOwner, "Owner", "transfer_workspace_owner restore response");

  const addedUser = await callTool("add_workspace_member", {
    workspaceId,
    userId: notificationSourceUserId,
    displayName: "MCP live smoke member",
    role: "guest",
  });
  assertIncludes(addedUser, notificationSourceUserId, "add_workspace_member user response");
  assertIncludes(addedUser, "Guest", "add_workspace_member user response");

  const updatedUserRole = await callTool("update_workspace_member_role", {
    workspaceId,
    userId: notificationSourceUserId,
    role: "member",
  });
  assertIncludes(updatedUserRole, notificationSourceUserId, "update_workspace_member_role response");
  assertIncludes(updatedUserRole, "Member", "update_workspace_member_role response");
  const filteredRoleUpdateAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "workspace_member.role_update",
    auditLimit: 5,
  });
  assertIncludes(filteredRoleUpdateAudit, "audit action filter: workspace_member.role_update", "filtered workspace member role audit response");
  assertIncludes(filteredRoleUpdateAudit, "Workspace Member Role Update", "filtered workspace member role audit response");

  const removedUser = await callTool("remove_workspace_member", {
    workspaceId,
    userId: notificationSourceUserId,
  });
  assertNotIncludes(removedUser, notificationSourceUserId, "remove_workspace_member response");
  const filteredMemberRemoveAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "workspace_member.remove",
    auditLimit: 5,
  });
  assertIncludes(filteredMemberRemoveAudit, "audit action filter: workspace_member.remove", "filtered workspace member removal audit response");
  assertIncludes(filteredMemberRemoveAudit, "Workspace Member Remove", "filtered workspace member removal audit response");

  const directoryBeforeOrganizationRemoval = await callTool("get_organization_directory", { organizationId });
  const notificationSourceOrganizationMemberId = matchRequired(
    directoryBeforeOrganizationRemoval,
    new RegExp(`- [^\\n]+\\n  id:\\s*([^\\s]+)\\n  user id:\\s*${escapeRegExp(notificationSourceUserId)}`),
    "notification source organization member id",
  );
  const organizationGroupName = `MCP live group ${suffix}`;
  const createdOrganizationGroup = await callTool("create_organization_group", {
    organizationId,
    name: organizationGroupName,
  });
  assertIncludes(createdOrganizationGroup, "## Groups", "create_organization_group response");
  assertIncludes(createdOrganizationGroup, organizationGroupName, "create_organization_group response");
  const organizationGroupId = matchRequired(
    createdOrganizationGroup,
    new RegExp(`- ${escapeRegExp(organizationGroupName)}\\n  id:\\s*([^\\s]+)`),
    "organization group id",
  );
  const updatedOrganizationGroupName = `${organizationGroupName} Updated`;
  const updatedOrganizationGroup = await callTool("update_organization_group", {
    organizationId,
    organizationGroupId,
    name: updatedOrganizationGroupName,
  });
  assertIncludes(updatedOrganizationGroup, updatedOrganizationGroupName, "update_organization_group response");
  const addedOrganizationGroupMember = await callTool("add_organization_group_member", {
    organizationId,
    organizationGroupId,
    organizationMemberId: notificationSourceOrganizationMemberId,
  });
  assertIncludes(addedOrganizationGroupMember, updatedOrganizationGroupName, "add_organization_group_member response");
  assertIncludes(addedOrganizationGroupMember, "members: 1", "add_organization_group_member response");
  const grantedGroupAccess = await callTool("grant_page_access", {
    pageId,
    label: updatedOrganizationGroupName,
    principalType: "group",
    principalId: organizationGroupId,
    role: "full_access",
  });
  assertIncludes(grantedGroupAccess, `group:${organizationGroupId}`, "group grant_page_access response");
  assertIncludes(grantedGroupAccess, "Full access", "group grant_page_access response");
  assertIncludes(grantedGroupAccess, "can manage sharing: yes", "group grant_page_access response");
  const organizationGroupPermissionId = matchRequired(
    grantedGroupAccess,
    new RegExp(`${escapeRegExp(updatedOrganizationGroupName)} \\(group:${escapeRegExp(organizationGroupId)}\\) — Full access \\[([^\\]]+)\\]`),
    "organization group page permission id",
  );
  createdPermissionIds.push(organizationGroupPermissionId);
  const revokedGroupAccess = await callTool("revoke_page_access", {
    permissionId: organizationGroupPermissionId,
  });
  assertIncludes(revokedGroupAccess, organizationGroupPermissionId, "group revoke_page_access response");
  const removedOrganizationGroupMember = await callTool("remove_organization_group_member", {
    organizationId,
    organizationGroupId,
    organizationMemberId: notificationSourceOrganizationMemberId,
  });
  assertIncludes(removedOrganizationGroupMember, updatedOrganizationGroupName, "remove_organization_group_member response");
  assertIncludes(removedOrganizationGroupMember, "members: 0", "remove_organization_group_member response");
  const deletedOrganizationGroup = await callTool("delete_organization_group", {
    organizationId,
    organizationGroupId,
  });
  assertNotIncludes(deletedOrganizationGroup, updatedOrganizationGroupName, "delete_organization_group response");
  const removedOrganizationMember = await callTool("remove_organization_member", {
    organizationId,
    organizationMemberId: notificationSourceOrganizationMemberId,
  });
  assertNotIncludes(removedOrganizationMember, `user id: ${notificationSourceUserId}`, "remove_organization_member response");
  assertIncludes(removedOrganizationMember, "Organization Member Remove", "remove_organization_member response");
  const filteredOrganizationAudit = await callTool("get_organization_directory", {
    organizationId,
    auditAction: "organization_member.remove",
    auditLimit: 5,
  });
  assertIncludes(filteredOrganizationAudit, "audit action filter: organization_member.remove", "filtered organization directory response");
  assertIncludes(filteredOrganizationAudit, "Organization Member Remove", "filtered organization directory response");
  assertNotIncludes(filteredOrganizationAudit, "Workspace Owner Transfer", "filtered organization directory response");

  const notificationWorkspace = await callNotificationSourceTool("get_workspace");
  const notificationWorkspaceId = matchRequired(
    notificationWorkspace,
    /^current fallback id:\s*([^\s]+)/m,
    "notification source workspace id",
  );
  const notificationTitle = `MCP live smoke notification source ${suffix}`;
  const notificationPage = await callNotificationSourceTool("create_page", {
    title: notificationTitle,
    content: `Notification source page for ${currentUserId}`,
  });
  const notificationPageId = matchRequired(notificationPage, /\(id:\s*([^)]+)\)/, "notification source page id");
  notificationSourcePageIds.push(notificationPageId);

  const notificationGrant = await callNotificationSourceTool("grant_page_access", {
    pageId: notificationPageId,
    label: "MCP live smoke notification recipient",
    role: "comment",
    principalType: "user",
    principalId: currentUserId,
  });
  assertIncludes(notificationGrant, "Can comment", "notification source grant_page_access response");
  const notificationPermissionId = matchRequired(notificationGrant, /\s\[([^\]]+)\]/, "notification source permission id");
  notificationSourcePermissionIds.push(notificationPermissionId);

  const notifications = await callTool("list_notifications", {
    workspaceId: notificationWorkspaceId,
    includeRead: false,
    kind: "system",
  });
  assertIncludes(notifications, notificationTitle, "list_notifications response");
  assertIncludes(notifications, "unread: 1", "list_notifications response");
  const notificationActivityKey = matchRequired(notifications, /activity key:\s*([^\n]+)/, "notification activity key");

  const markedNotifications = await callTool("mark_notifications_read", {
    workspaceId: notificationWorkspaceId,
    activityKeys: [notificationActivityKey],
  });
  assertIncludes(markedNotifications, "Marked 1 notification read.", "mark_notifications_read response");
  assertIncludes(markedNotifications, "unread: 0", "mark_notifications_read response");

  const allReadNotifications = await callTool("mark_all_notifications_read", {
    workspaceId: notificationWorkspaceId,
  });
  assertIncludes(allReadNotifications, "unread: 0", "mark_all_notifications_read response");

  const directPageViewAccess = await callNotificationSourceTool("update_page_access", {
    permissionId: notificationPermissionId,
    role: "view",
  });
  assertIncludes(directPageViewAccess, "Can view", "notification source view update_page_access response");
  assertIncludes(directPageViewAccess, "can manage sharing: yes", "notification source view update_page_access response");
  const directPageWorkspaces = await callTool("list_workspaces");
  assertIncludes(directPageWorkspaces, notificationWorkspaceId, "direct page list_workspaces response");
  const directPageList = await callTool("list_pages", { workspaceId: notificationWorkspaceId });
  assertIncludes(directPageList, notificationTitle, "direct page list_pages response");
  assertIncludes(directPageList, notificationPageId, "direct page list_pages response");
  const directPageSearch = await callTool("search_pages", {
    workspaceId: notificationWorkspaceId,
    query: notificationTitle,
  });
  assertIncludes(directPageSearch, notificationTitle, "direct page search_pages response");
  assertIncludes(directPageSearch, notificationPageId, "direct page search_pages response");
  const directPageBody = await callTool("get_page", { pageId: notificationPageId });
  assertIncludes(directPageBody, notificationTitle, "direct page get_page response");
  assertIncludes(directPageBody, `Notification source page for ${currentUserId}`, "direct page get_page response");
  const directPageBlockSearch = await callTool("search_blocks", {
    workspaceId: notificationWorkspaceId,
    query: currentUserId,
  });
  assertIncludes(directPageBlockSearch, notificationPageId, "direct page search_blocks response");
  await assertWorkspaceAdminToolsDenied(
    callToolResult,
    notificationWorkspaceId,
    "direct page view non-member",
    `mcp-direct-view-denied-invite-${suffix}@example.com`,
  );
  const directPageViewCommentAttempt = await callToolResult("add_comment", {
    pageId: notificationPageId,
    text: `MCP direct page view denied comment ${suffix}`,
  });
  if (!directPageViewCommentAttempt.result.isError) {
    throw new Error(
      `direct view add_comment unexpectedly succeeded:\n${directPageViewCommentAttempt.text}`,
    );
  }
  assertAccessDenial(directPageViewCommentAttempt.text, "direct page view add_comment denial");

  const directPageCommentAccess = await callNotificationSourceTool("update_page_access", {
    permissionId: notificationPermissionId,
    role: "comment",
  });
  assertIncludes(directPageCommentAccess, "Can comment", "notification source comment update_page_access response");
  assertIncludes(directPageCommentAccess, "can manage sharing: yes", "notification source comment update_page_access response");
  const directPageCommentText = `MCP direct page comment ${suffix}`;
  const directPageComment = await callTool("add_comment", {
    pageId: notificationPageId,
    text: directPageCommentText,
  });
  assertIncludes(directPageComment, "Added page comment", "direct page add_comment response");
  const directPageComments = await callTool("list_comments", {
    pageId: notificationPageId,
    includeResolved: true,
  });
  assertIncludes(directPageComments, directPageCommentText, "direct page list_comments response");
  await assertWorkspaceAdminToolsDenied(
    callToolResult,
    notificationWorkspaceId,
    "direct page comment non-member",
    `mcp-direct-comment-denied-invite-${suffix}@example.com`,
  );

  const directPageEditAccess = await callNotificationSourceTool("update_page_access", {
    permissionId: notificationPermissionId,
    role: "edit",
  });
  assertIncludes(directPageEditAccess, "Can edit", "notification source update_page_access response");
  assertIncludes(directPageEditAccess, "can manage sharing: yes", "notification source update_page_access response");
  const directPageEditText = `MCP direct page edit ${suffix}`;
  const directPageEdit = await callTool("add_content", {
    pageId: notificationPageId,
    markdown: directPageEditText,
  });
  assertIncludes(directPageEdit, "Appended 1 block", "direct page edit add_content response");
  const directPageAfterEdit = await callTool("get_page", { pageId: notificationPageId });
  assertIncludes(directPageAfterEdit, directPageEditText, "direct page get_page after edit response");
  const directPageShareAttempt = await callToolResult("grant_page_access", {
    pageId: notificationPageId,
    label: `mcp-direct-edit-share-${suffix}@example.com`,
    role: "view",
    principalType: "email",
  });
  if (!directPageShareAttempt.result.isError) {
    throw new Error(
      `direct edit grant_page_access unexpectedly succeeded:\n${directPageShareAttempt.text}`,
    );
  }
  assertAccessDenial(directPageShareAttempt.text, "direct page edit grant_page_access denial");
  await assertWorkspaceAdminToolsDenied(
    callToolResult,
    notificationWorkspaceId,
    "direct page edit non-member",
    `mcp-direct-edit-denied-invite-${suffix}@example.com`,
  );

  const integrationPrincipalTitle = `MCP integration principal page ${suffix}`;
  const integrationPrincipalPage = await callNotificationSourceTool("create_page", {
    title: integrationPrincipalTitle,
    content: `Integration principal page for ${currentUserId}`,
  });
  const integrationPrincipalPageId = matchRequired(
    integrationPrincipalPage,
    /\(id:\s*([^)]+)\)/,
    "integration principal page id",
  );
  notificationSourcePageIds.push(integrationPrincipalPageId);
  const integrationPrincipalGrant = await callNotificationSourceTool("grant_page_access", {
    pageId: integrationPrincipalPageId,
    label: "MCP live smoke service principal",
    role: "view",
    principalType: "integration",
    principalId: currentUserId,
  });
  assertIncludes(integrationPrincipalGrant, "Can view", "integration principal grant_page_access response");
  assertIncludes(
    integrationPrincipalGrant,
    `integration:${currentUserId}`,
    "integration principal grant_page_access response",
  );
  const integrationPrincipalPermissionId = matchRequired(
    integrationPrincipalGrant,
    /\s\[([^\]]+)\]/,
    "integration principal permission id",
  );
  notificationSourcePermissionIds.push(integrationPrincipalPermissionId);
  const integrationPrincipalList = await callTool("list_pages", { workspaceId: notificationWorkspaceId });
  assertIncludes(integrationPrincipalList, integrationPrincipalTitle, "integration principal list_pages response");
  assertIncludes(integrationPrincipalList, integrationPrincipalPageId, "integration principal list_pages response");
  const integrationPrincipalBody = await callTool("get_page", { pageId: integrationPrincipalPageId });
  assertIncludes(integrationPrincipalBody, integrationPrincipalTitle, "integration principal get_page response");
  assertIncludes(
    integrationPrincipalBody,
    `Integration principal page for ${currentUserId}`,
    "integration principal get_page response",
  );
  const integrationPrincipalCommentAttempt = await callToolResult("add_comment", {
    pageId: integrationPrincipalPageId,
    text: `MCP integration principal denied comment ${suffix}`,
  });
  if (!integrationPrincipalCommentAttempt.result.isError) {
    throw new Error(
      `integration principal view add_comment unexpectedly succeeded:\n${integrationPrincipalCommentAttempt.text}`,
    );
  }
  assertAccessDenial(integrationPrincipalCommentAttempt.text, "integration principal view add_comment denial");

  const directEmailChildTitle = `MCP direct email child page ${suffix}`;
  const directEmailChildBody = `MCP direct email inherited child body ${suffix}`;
  const directEmailChildPage = await callNotificationSourceTool("create_page", {
    parentId: notificationPageId,
    title: directEmailChildTitle,
    content: directEmailChildBody,
  });
  const directEmailChildPageId = matchRequired(
    directEmailChildPage,
    /\(id:\s*([^)]+)\)/,
    "direct email child page id",
  );
  notificationSourcePageIds.push(directEmailChildPageId);

  const directEmailDatabaseTitle = `MCP direct email database ${suffix}`;
  const directEmailDatabase = await callNotificationSourceTool("create_database", {
    parentId: notificationPageId,
    parentType: "page",
    title: directEmailDatabaseTitle,
    seedRows: false,
    properties: [
      { name: "Task", type: "title" },
      { name: "Notes", type: "rich_text" },
    ],
  });
  const directEmailDatabaseId = matchRequired(
    directEmailDatabase,
    /database id:\s*([^\s]+)/,
    "direct email inherited database id",
  );
  notificationSourcePageIds.push(directEmailDatabaseId);
  const directEmailRowTitle = `MCP direct email row ${suffix}`;
  const directEmailRowNotes = `MCP direct email row notes ${suffix}`;
  const directEmailRow = await callNotificationSourceTool("add_database_row", {
    databaseId: directEmailDatabaseId,
    title: directEmailRowTitle,
    properties: { Notes: directEmailRowNotes },
  });
  const directEmailRowId = matchRequired(directEmailRow, /row id:\s*([^\s]+)/, "direct email inherited row id");
  notificationSourcePageIds.push(directEmailRowId);
  const directEmailRowBody = `MCP direct email row body ${suffix}`;
  const directEmailRowContent = await callNotificationSourceTool("add_content", {
    pageId: directEmailRowId,
    markdown: directEmailRowBody,
  });
  assertIncludes(directEmailRowContent, "Appended", "direct email inherited row add_content response");

  const directEmailShareAddress = `mcp-live-email-share-${suffix}@example.com`;
  await startEmailShareClient(directEmailShareAddress, `McpEmailShare${suffix}!aA1`);
  const directEmailGrant = await callNotificationSourceTool("grant_page_access", {
    pageId: notificationPageId,
    label: directEmailShareAddress.toUpperCase(),
    role: "comment",
    principalType: "email",
  });
  assertIncludes(directEmailGrant, "Can comment", "direct email grant_page_access response");
  assertIncludes(directEmailGrant, directEmailShareAddress, "direct email grant_page_access response");
  const directEmailPermissionId = matchRequired(
    directEmailGrant,
    new RegExp(`${escapeRegExp(directEmailShareAddress)}[^\\n]*\\[([^\\]]+)\\]`, "i"),
    "direct email permission id",
  );
  notificationSourcePermissionIds.push(directEmailPermissionId);

  const directEmailList = await callEmailShareTool("list_pages", {
    workspaceId: notificationWorkspaceId,
  });
  assertIncludes(directEmailList, notificationTitle, "direct email list_pages response");
  assertIncludes(directEmailList, notificationPageId, "direct email list_pages response");
  const directEmailWorkspaces = await callEmailShareTool("list_workspaces");
  assertIncludes(directEmailWorkspaces, notificationWorkspaceId, "direct email list_workspaces response");
  const directEmailPage = await callEmailShareTool("get_page", { pageId: notificationPageId });
  assertIncludes(directEmailPage, notificationTitle, "direct email get_page response");
  assertIncludes(directEmailPage, `Notification source page for ${currentUserId}`, "direct email get_page response");
  const directEmailChildPageBody = await callEmailShareTool("get_page", { pageId: directEmailChildPageId });
  assertIncludes(directEmailChildPageBody, directEmailChildTitle, "direct email inherited child get_page response");
  assertIncludes(directEmailChildPageBody, directEmailChildBody, "direct email inherited child get_page response");
  const directEmailDatabaseDescription = await callEmailShareTool("describe_database", {
    databaseId: directEmailDatabaseId,
  });
  assertIncludes(directEmailDatabaseDescription, directEmailDatabaseTitle, "direct email inherited describe_database response");
  assertIncludes(directEmailDatabaseDescription, "Notes", "direct email inherited describe_database response");
  const directEmailDatabaseRows = await callEmailShareTool("query_database", {
    databaseId: directEmailDatabaseId,
    search: directEmailRowTitle,
  });
  assertIncludes(directEmailDatabaseRows, directEmailRowId, "direct email inherited query_database response");
  assertIncludes(directEmailDatabaseRows, directEmailRowTitle, "direct email inherited query_database response");
  assertIncludes(directEmailDatabaseRows, directEmailRowNotes, "direct email inherited query_database response");
  const directEmailRowPage = await callEmailShareTool("get_page", { pageId: directEmailRowId });
  assertIncludes(directEmailRowPage, directEmailRowTitle, "direct email inherited row get_page response");
  assertIncludes(directEmailRowPage, directEmailRowBody, "direct email inherited row get_page response");
  const directEmailRowBlockSearch = await callEmailShareTool("search_blocks", {
    workspaceId: notificationWorkspaceId,
    query: directEmailRowBody,
  });
  assertIncludes(directEmailRowBlockSearch, directEmailRowId, "direct email inherited row search_blocks response");
  const directEmailAccess = await callEmailShareTool("list_page_access", {
    pageId: notificationPageId,
  });
  assertIncludes(directEmailAccess, "can manage sharing: no", "direct email list_page_access response");
  await assertWorkspaceAdminToolsDenied(
    callEmailShareToolResult,
    notificationWorkspaceId,
    "direct email non-member",
    `mcp-direct-email-denied-invite-${suffix}@example.com`,
  );
  const directEmailCommentText = `MCP direct email page comment ${suffix}`;
  const directEmailComment = await callEmailShareTool("add_comment", {
    pageId: notificationPageId,
    text: directEmailCommentText,
  });
  assertIncludes(directEmailComment, "Added page comment", "direct email add_comment response");
  const directEmailEditAttempt = await callEmailShareToolResult("add_content", {
    pageId: notificationPageId,
    markdown: `MCP direct email denied edit ${suffix}`,
  });
  if (!directEmailEditAttempt.result.isError) {
    throw new Error(
      `direct email comment access add_content unexpectedly succeeded:\n${directEmailEditAttempt.text}`,
    );
  }
  assertAccessDenial(directEmailEditAttempt.text, "direct email comment access add_content denial");
  const directEmailRowWriteAttempt = await callEmailShareToolResult("add_database_row", {
    databaseId: directEmailDatabaseId,
    title: `MCP direct email denied row ${suffix}`,
  });
  if (!directEmailRowWriteAttempt.result.isError) {
    throw new Error(
      `direct email comment access add_database_row unexpectedly succeeded:\n${directEmailRowWriteAttempt.text}`,
    );
  }
  assertAccessDenial(directEmailRowWriteAttempt.text, "direct email comment access add_database_row denial");

  const directEmailRevokedAccess = await callNotificationSourceTool("revoke_page_access", {
    permissionId: directEmailPermissionId,
  });
  assertIncludes(directEmailRevokedAccess, directEmailPermissionId, "direct email revoke_page_access response");
  assertIncludes(directEmailRevokedAccess, "can manage sharing: yes", "direct email revoke_page_access response");
  removeTrackedNotificationSourcePermission(directEmailPermissionId);

  const directEmailAccessAfterRevoke = await callNotificationSourceTool("list_page_access", {
    pageId: notificationPageId,
  });
  assertNotIncludes(
    directEmailAccessAfterRevoke,
    directEmailPermissionId,
    "direct email owner list_page_access after revoke response",
  );
  assertNotIncludes(
    directEmailAccessAfterRevoke,
    directEmailShareAddress,
    "direct email owner list_page_access after revoke response",
  );

  const directEmailPageAfterRevoke = await callEmailShareToolResult("get_page", { pageId: notificationPageId });
  if (!directEmailPageAfterRevoke.result.isError) {
    throw new Error(
      `direct email get_page after revoke unexpectedly succeeded:\n${directEmailPageAfterRevoke.text}`,
    );
  }
  assertAccessDenial(directEmailPageAfterRevoke.text, "direct email get_page after revoke");
  const directEmailSearchAfterRevoke = await callEmailShareTool("search_pages", {
    query: directEmailRowTitle,
  });
  assertNotIncludes(
    directEmailSearchAfterRevoke,
    directEmailRowId,
    "direct email search_pages after revoke response",
  );
  const directPageWorkspacesAfterRevoke = await callEmailShareTool("list_workspaces");
  assertIncludes(directPageWorkspacesAfterRevoke, "# Workspaces", "direct page list_workspaces after revoke response");
  const directEmailListAfterRevoke = await callEmailShareToolResult("list_pages", {
    workspaceId: notificationWorkspaceId,
  });
  if (!directEmailListAfterRevoke.result.isError) {
    assertNotIncludes(
      directEmailListAfterRevoke.text,
      notificationPageId,
      "direct email list_pages after revoke response",
    );
  }
  await cleanupNotificationSourcePermissions();
  await cleanupNotificationSourcePages();

  const enabledSharing = await callTool("set_page_web_sharing", {
    pageId,
    public: true,
    expiresIn: "7d",
  });
  assertIncludes(enabledSharing, "Enabled Share to web", "set_page_web_sharing response");
  assertIncludes(enabledSharing, "can manage sharing: yes", "set_page_web_sharing response");
  assertIncludes(enabledSharing, "public link expires:", "set_page_web_sharing response");
  const shareId = matchRequired(enabledSharing, /public link:\s*\/share\/([^\s]+)/, "public share id");

  const sharedPage = await callTool("get_shared_page", { shareId });
  assertIncludes(sharedPage, pageTitle, "get_shared_page response");
  assertIncludes(sharedPage, "created through MCP", "get_shared_page response");

  const access = await callTool("list_page_access", { pageId });
  assertIncludes(access, "share to web: yes", "list_page_access response");
  assertIncludes(access, "can manage sharing: yes", "list_page_access response");
  assertIncludes(access, `/share/${shareId}`, "list_page_access response");
  assertIncludes(access, "public link expires:", "list_page_access response");

  const clearedSharingExpiry = await callTool("set_page_web_sharing", {
    pageId,
    public: true,
    expiresAt: null,
  });
  assertIncludes(clearedSharingExpiry, "Enabled Share to web", "clear share expiry response");
  assertIncludes(clearedSharingExpiry, "public link expires: never", "clear share expiry response");

  const grantedAccess = await callTool("grant_page_access", {
    pageId,
    label: `mcp-live-smoke-${suffix}@example.com`,
    role: "comment",
    principalType: "email",
  });
  assertIncludes(grantedAccess, "Can comment", "grant_page_access response");
  assertIncludes(grantedAccess, "can manage sharing: yes", "grant_page_access response");
  const permissionId = matchRequired(grantedAccess, /\s\[([^\]]+)\]/, "permission id");
  createdPermissionIds.push(permissionId);

  const updatedAccess = await callTool("update_page_access", {
    permissionId,
    role: "full_access",
  });
  assertIncludes(updatedAccess, "Full access", "update_page_access response");
  assertIncludes(updatedAccess, "can manage sharing: yes", "update_page_access response");

  const revokedAccess = await callTool("revoke_page_access", { permissionId });
  assertIncludes(revokedAccess, permissionId, "revoke_page_access response");
  assertIncludes(revokedAccess, "can manage sharing: yes", "revoke_page_access response");
  removeTrackedPermission(permissionId);

  const disabledSharing = await callTool("set_page_web_sharing", {
    pageId,
    public: false,
  });
  assertIncludes(disabledSharing, "Disabled Share to web", "set_page_web_sharing disable response");
  assertIncludes(disabledSharing, "can manage sharing: yes", "set_page_web_sharing disable response");
  assertIncludes(disabledSharing, "public link: off", "set_page_web_sharing disable response");

  const fileBody = `mcp-live-smoke-${suffix}`.padEnd(32, ".").slice(0, 32);
  const preparedUpload = await callTool("prepare_file_upload", {
    pageId,
    scope: "blocks/files",
    name: `mcp-live-smoke-${suffix}.txt`,
    size: Buffer.byteLength(fileBody),
    contentType: "text/plain",
  });
  const uploadId = matchRequired(preparedUpload, /^id:\s*([^\s]+)/m, "prepared file upload id");
  const uploadKey = matchRequired(preparedUpload, /^key:\s*([^\s]+)/m, "prepared file upload key");
  const uploadUrl = matchRequired(preparedUpload, /^upload url:\s*(https?:\/\/[^\s]+)/m, "prepared upload URL");
  createdFileUploadIds.push(uploadId);
  createdFileUploadTargets.set(uploadId, { workspaceId, uploadId });
  assertIncludes(preparedUpload, "status: pending", "prepare_file_upload response");

  const uploadForm = new FormData();
  uploadForm.append("file", new Blob([fileBody], { type: "text/plain" }), uploadKey);
  uploadForm.append("key", uploadKey);
  uploadForm.append("customMetadata", JSON.stringify({
    uploadId,
    workspaceId,
    pageId,
    blockId: "",
    originalName: `mcp-live-smoke-${suffix}.txt`,
  }));
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    body: uploadForm,
  });
  if (!uploaded.ok) {
    throw new Error(`signed file upload failed (HTTP ${uploaded.status})`);
  }
  const completedFile = await callTool("complete_file_upload", { uploadId, key: uploadKey });
  assertIncludes(completedFile, "status: uploaded", "complete_file_upload response");

  const listedFiles = await callTool("list_files", { pageId });
  assertIncludes(listedFiles, uploadId, "list_files response");
  assertIncludes(listedFiles, `mcp-live-smoke-${suffix}.txt`, "list_files response");

  const fileReport = await callTool("get_file_report", { maintenanceLimit: 5 });
  assertIncludes(fileReport, "# File Report", "get_file_report response");
  assertIncludes(fileReport, "pending grants:", "get_file_report response");
  const organizationFileReport = await callTool("get_file_report", { organizationId, maintenanceLimit: 5 });
  assertIncludes(organizationFileReport, `organization id: ${organizationId}`, "organization get_file_report response");
  assertIncludes(organizationFileReport, "## By Workspace", "organization get_file_report response");

  const cleanupDryRun = await callTool("cleanup_expired_files", { dryRun: true, limit: 5 });
  assertIncludes(cleanupDryRun, "Dry run", "cleanup_expired_files response");

  const downloadUrl = await callTool("create_file_download_url", { workspaceId, uploadId, expiresIn: "5m" });
  assertIncludes(downloadUrl, "expires:", "create_file_download_url response");

  const deletedFile = await callTool("delete_file", { workspaceId, uploadId });
  assertIncludes(deletedFile, "status: deleted", "delete_file response");
  removeTrackedFileUpload(uploadId);

  const filesAfterDelete = await callTool("list_files", { pageId });
  assertIncludes(filesAfterDelete, "No files found.", "list_files after delete response");

  const databaseTitle = `MCP live smoke database ${suffix}`;
  const createdDatabase = await callTool("create_database", {
    title: databaseTitle,
    viewType: "table",
    seedRows: false,
  });
  const databaseId = matchRequired(createdDatabase, /database id:\s*([^\s]+)/, "created database id");
  createdPageIds.push(databaseId);
  assertIncludes(createdDatabase, "rows: 0", "create_database response");

  const describedDatabaseResult = await callToolResult("describe_database", { databaseId });
  const describedDatabase = describedDatabaseResult.text;
  assertIncludes(describedDatabase, databaseTitle, "describe_database response");
  assertIncludes(describedDatabase, "Status [status]", "describe_database response");
  assertDatabaseDescriptionStructuredContent(
    describedDatabaseResult,
    { databaseId, propertyNames: ["Name", "Status"], viewName: "Table" },
    "describe_database response",
  );
  const defaultNamePropertyId = matchRequired(
    describedDatabase,
    /- Name \[title\] id:\s*([^\s]+)/,
    "default database title property id",
  );

  const customDatabaseTitle = `MCP custom database ${suffix}`;
  const createdCustomDatabase = await callTool("create_database", {
    title: customDatabaseTitle,
    viewType: "board",
    seedRows: false,
    properties: [
      { name: "Issue", type: "title" },
      { name: "Estimate", type: "number", numberFormat: "number" },
      { name: "Stage", type: "status", options: ["Todo", "Doing", "Done"] },
      { name: "Estimate label", type: "formula", formula: 'format(prop("Estimate"))' },
      {
        name: "Advanced label",
        type: "formula",
        formula:
          'lets(base, prop("Estimate"), window, dateRange(parseDate("2026-06-24"), parseDate("2026-06-30")), concat(format(min(3, base, 4)), "/", format(max(3, base, 4)), "/", format(round(sqrt(5), 2)), "/", format(pow(2, 3) + 2 ^ 3), "/", format(dateBetween(dateEnd(window), dateStart(window), "days"))))',
      },
    ],
  });
  const customDatabaseId = matchRequired(createdCustomDatabase, /database id:\s*([^\s]+)/, "created custom database id");
  createdPageIds.push(customDatabaseId);
  assertIncludes(createdCustomDatabase, `Created database "${customDatabaseTitle}"`, "custom create_database response");
  assertIncludes(createdCustomDatabase, "view: Board [board]", "custom create_database response");
  assertIncludes(createdCustomDatabase, "Issue [title]", "custom create_database response");
  assertIncludes(createdCustomDatabase, "Estimate [number]", "custom create_database response");
  assertIncludes(createdCustomDatabase, "Stage [status]", "custom create_database response");
  assertIncludes(createdCustomDatabase, "Estimate label [formula]", "custom create_database response");
  assertIncludes(createdCustomDatabase, "Advanced label [formula]", "custom create_database response");

  await startPolicyClient({
    HANJI_MCP_ALLOWED_WORKSPACE_IDS: workspaceId,
    HANJI_MCP_ALLOWED_DATABASE_IDS: customDatabaseId,
  });
  const databasePolicyWrite = await callPolicyTool("create_database_view", {
    databaseId,
    type: "table",
    name: `Database policy denied ${suffix}`,
  });
  if (!databasePolicyWrite.result.isError || !databasePolicyWrite.text.includes("MCP access policy denied")) {
    throw new Error(`database MCP allowlist did not block create_database_view:\n${databasePolicyWrite.text}`);
  }
  await closePolicyClient();

  const rollupTargetTitle = `Rollup target ${suffix}`;
  const rollupTargetRow = await callTool("add_database_row", {
    databaseId,
    title: rollupTargetTitle,
    empty: true,
  });
  const rollupTargetRowId = matchRequired(rollupTargetRow, /row id:\s*([^\s]+)/, "rollup target row id");
  const relationPropertyName = `Linked project ${suffix}`;
  const addedRelationProperty = await callTool("add_database_property", {
    databaseId: customDatabaseId,
    name: relationPropertyName,
    type: "relation",
    relationDatabaseId: databaseId,
  });
  const relationPropertyId = matchRequired(addedRelationProperty, /property id:\s*([^\s]+)/, "custom relation property id");
  const rollupPropertyName = `Linked project title ${suffix}`;
  const addedRollupProperty = await callTool("add_database_property", {
    databaseId: customDatabaseId,
    name: rollupPropertyName,
    type: "rollup",
    rollupRelationPropertyId: relationPropertyId,
    rollupTargetPropertyId: defaultNamePropertyId,
    rollupFunction: "show_original",
  });
  assertIncludes(addedRollupProperty, `Added property "${rollupPropertyName}"`, "custom rollup property response");
  const customFormulaRow = await callTool("add_database_row", {
    databaseId: customDatabaseId,
    title: "Formula projection row",
    properties: {
      Estimate: 9,
      Stage: "Doing",
      [relationPropertyName]: [rollupTargetRowId],
    },
  });
  assertIncludes(customFormulaRow, "Created row", "custom formula row response");
  const customFormulaQuery = await callTool("query_database", {
    databaseId: customDatabaseId,
    search: "Formula projection row",
  });
  assertIncludes(customFormulaQuery, "Estimate label", "custom formula query response");
  assertIncludes(customFormulaQuery, "9", "custom formula query response");
  assertIncludes(customFormulaQuery, "Advanced label", "custom advanced formula query response");
  assertIncludes(customFormulaQuery, "3/9/2.24/16/6", "custom advanced formula query response");
  assertIncludes(customFormulaQuery, rollupPropertyName, "custom rollup query response");
  assertIncludes(customFormulaQuery, rollupTargetTitle, "custom rollup query response");

  const boardViewName = `MCP Board ${suffix}`;
  const createdView = await callTool("create_database_view", {
    databaseId,
    type: "board",
    name: boardViewName,
    groupBy: "Status",
    visibleProperties: ["Name", "Status", "Tags"],
  });
  assertIncludes(createdView, `Created view "${boardViewName}"`, "create_database_view response");
  assertIncludes(createdView, "configured:", "create_database_view response");

  const updatedViewName = `MCP List ${suffix}`;
  const updatedView = await callTool("update_database_view", {
    databaseId,
    view: boardViewName,
    name: updatedViewName,
    type: "list",
    visibleProperties: ["Name", "Status"],
    groupBy: "",
  });
  assertIncludes(updatedView, `Updated view "${updatedViewName}"`, "update_database_view response");
  assertIncludes(updatedView, "changed:", "update_database_view response");

  const deletedView = await callTool("delete_database_view", {
    databaseId,
    view: updatedViewName,
  });
  assertIncludes(deletedView, `Deleted view "${updatedViewName}"`, "delete_database_view response");

  const propertyName = `MCP Priority ${suffix}`;
  const addedProperty = await callTool("add_database_property", {
    databaseId,
    name: propertyName,
    type: "select",
    options: ["High", "Low"],
  });
  const propertyId = matchRequired(addedProperty, /property id:\s*([^\s]+)/, "created database property id");
  assertIncludes(addedProperty, `Added property "${propertyName}"`, "add_database_property response");

  const updatedPropertyName = `MCP Risk ${suffix}`;
  const updatedProperty = await callTool("update_database_property", {
    databaseId,
    property: propertyId,
    name: updatedPropertyName,
    description: "Live smoke temporary property",
    options: ["Low", "High", "Blocked"],
    hideWhenEmpty: true,
  });
  assertIncludes(updatedProperty, `Updated property "${updatedPropertyName}"`, "update_database_property response");
  assertIncludes(updatedProperty, "changed:", "update_database_property response");

  const deletedProperty = await callTool("delete_database_property", {
    databaseId,
    property: updatedPropertyName,
  });
  assertIncludes(deletedProperty, `Deleted property "${updatedPropertyName}"`, "delete_database_property response");
  assertIncludes(deletedProperty, "Cleaned", "delete_database_property cleanup response");

  const databaseAfterPropertyDelete = await callTool("describe_database", { databaseId });
  assertNotIncludes(
    databaseAfterPropertyDelete,
    updatedPropertyName,
    "describe_database after delete_database_property response",
  );

  const scorePropertyName = `MCP Score ${suffix}`;
  const addedScoreProperty = await callTool("add_database_property", {
    databaseId,
    name: scorePropertyName,
    type: "number",
    numberFormat: "number",
  });
  assertIncludes(addedScoreProperty, `Added property "${scorePropertyName}"`, "add_database_property score response");

  const duePropertyName = `MCP Due ${suffix}`;
  const addedDueProperty = await callTool("add_database_property", {
    databaseId,
    name: duePropertyName,
    type: "date",
  });
  assertIncludes(addedDueProperty, `Added property "${duePropertyName}"`, "add_database_property due response");

  const lanePropertyName = `MCP Lane ${suffix}`;
  const addedLaneProperty = await callTool("add_database_property", {
    databaseId,
    name: lanePropertyName,
    type: "select",
    options: ["Frontend", "Backend"],
  });
  assertIncludes(addedLaneProperty, `Added property "${lanePropertyName}"`, "add_database_property lane response");

  const viewAlphaTitle = `MCP view alpha ${suffix}`;
  const viewBetaTitle = `MCP view beta ${suffix}`;
  const viewGammaTitle = `MCP view gamma ${suffix}`;
  const viewAlphaRow = await callTool("add_database_row", {
    databaseId,
    title: viewAlphaTitle,
    empty: true,
    properties: {
      Status: "Done",
      Tags: ["Idea"],
      [scorePropertyName]: 3,
      [duePropertyName]: "2026-01-01",
      [lanePropertyName]: "Frontend",
    },
  });
  const viewAlphaRowId = matchRequired(viewAlphaRow, /row id:\s*([^\s]+)/, "view alpha row id");

  const viewBetaRow = await callTool("add_database_row", {
    databaseId,
    title: viewBetaTitle,
    empty: true,
    properties: {
      Status: "In progress",
      Tags: ["Urgent"],
      [scorePropertyName]: 7,
      [duePropertyName]: "2026-01-02",
      [lanePropertyName]: "Backend",
    },
  });
  const viewBetaRowId = matchRequired(viewBetaRow, /row id:\s*([^\s]+)/, "view beta row id");

  const viewGammaRow = await callTool("add_database_row", {
    databaseId,
    title: viewGammaTitle,
    empty: true,
    properties: {
      Status: "Done",
      Tags: ["Urgent"],
      [scorePropertyName]: 10,
      [duePropertyName]: "2026-01-03",
      [lanePropertyName]: "Backend",
    },
  });
  const viewGammaRowId = matchRequired(viewGammaRow, /row id:\s*([^\s]+)/, "view gamma row id");

  const movedGammaRow = await callTool("move_database_row", {
    rowId: viewGammaRowId,
    targetRowId: viewAlphaRowId,
    side: "before",
  });
  assertIncludes(movedGammaRow, viewGammaRowId, "move_database_row response");
  assertIncludes(movedGammaRow, viewAlphaRowId, "move_database_row response");
  assertIncludes(movedGammaRow, "position:", "move_database_row response");

  const queriedMovedRows = await callTool("query_database", {
    databaseId,
    limit: 10,
  });
  assertBefore(queriedMovedRows, viewGammaTitle, viewAlphaTitle, "query_database moved row order response");

  const directDatabaseGrant = await callTool("grant_page_access", {
    pageId: databaseId,
    label: "MCP live smoke direct database user",
    role: "view",
    principalType: "user",
    principalId: notificationSourceUserId,
  });
  assertIncludes(directDatabaseGrant, "Can view", "direct database grant_page_access response");
  assertIncludes(directDatabaseGrant, "can manage sharing: yes", "direct database grant_page_access response");
  const directDatabasePermissionId = matchRequired(
    directDatabaseGrant,
    /\s\[([^\]]+)\]/,
    "direct database permission id",
  );
  createdPermissionIds.push(directDatabasePermissionId);

  const directDatabaseList = await callNotificationSourceTool("list_pages", { workspaceId });
  assertIncludes(directDatabaseList, databaseTitle, "direct database list_pages response");
  assertIncludes(directDatabaseList, databaseId, "direct database list_pages response");
  const directDatabaseDescription = await callNotificationSourceTool("describe_database", { databaseId });
  assertIncludes(directDatabaseDescription, databaseTitle, "direct database describe_database response");
  assertIncludes(directDatabaseDescription, scorePropertyName, "direct database describe_database response");
  const directDatabaseQuery = await callNotificationSourceTool("query_database", {
    databaseId,
    search: viewGammaTitle,
  });
  assertIncludes(directDatabaseQuery, viewGammaRowId, "direct database query_database response");
  assertIncludes(directDatabaseQuery, viewGammaTitle, "direct database query_database response");
  await assertWorkspaceAdminToolsDenied(
    callNotificationSourceToolResult,
    workspaceId,
    "direct database view non-member",
    `mcp-direct-database-view-denied-invite-${suffix}@example.com`,
  );
  const directDatabaseViewWriteAttempt = await callNotificationSourceToolResult("add_database_row", {
    databaseId,
    title: `MCP direct database view denied row ${suffix}`,
    empty: true,
  });
  if (!directDatabaseViewWriteAttempt.result.isError) {
    throw new Error(
      `direct database view add_database_row unexpectedly succeeded:\n${directDatabaseViewWriteAttempt.text}`,
    );
  }
  assertAccessDenial(directDatabaseViewWriteAttempt.text, "direct database view add_database_row denial");

  const directDatabaseEditAccess = await callTool("update_page_access", {
    permissionId: directDatabasePermissionId,
    role: "edit",
  });
  assertIncludes(directDatabaseEditAccess, "Can edit", "direct database edit update_page_access response");
  assertIncludes(directDatabaseEditAccess, "can manage sharing: yes", "direct database edit update_page_access response");
  const directDatabaseEditRowTitle = `MCP direct database edit row ${suffix}`;
  const directDatabaseEditRow = await callNotificationSourceTool("add_database_row", {
    databaseId,
    title: directDatabaseEditRowTitle,
    empty: true,
    properties: {
      Status: "Done",
      Tags: ["Idea"],
      [scorePropertyName]: 4,
      [duePropertyName]: "2026-01-04",
      [lanePropertyName]: "Frontend",
    },
  });
  assertIncludes(directDatabaseEditRow, "Created row", "direct database edit add_database_row response");
  const directDatabaseEditRowId = matchRequired(
    directDatabaseEditRow,
    /row id:\s*([^\s]+)/,
    "direct database edit row id",
  );
  const directDatabaseQueryAfterEditWrite = await callNotificationSourceTool("query_database", {
    databaseId,
    search: directDatabaseEditRowTitle,
  });
  assertIncludes(
    directDatabaseQueryAfterEditWrite,
    directDatabaseEditRowId,
    "direct database query after edit write response",
  );
  assertIncludes(
    directDatabaseQueryAfterEditWrite,
    directDatabaseEditRowTitle,
    "direct database query after edit write response",
  );
  const directDatabaseEditShareAttempt = await callNotificationSourceToolResult("grant_page_access", {
    pageId: databaseId,
    label: `mcp-direct-database-edit-share-${suffix}@example.com`,
    role: "view",
    principalType: "email",
  });
  if (!directDatabaseEditShareAttempt.result.isError) {
    throw new Error(
      `direct database edit grant_page_access unexpectedly succeeded:\n${directDatabaseEditShareAttempt.text}`,
    );
  }
  assertAccessDenial(directDatabaseEditShareAttempt.text, "direct database edit grant_page_access denial");
  await assertWorkspaceAdminToolsDenied(
    callNotificationSourceToolResult,
    workspaceId,
    "direct database edit non-member",
    `mcp-direct-database-edit-denied-invite-${suffix}@example.com`,
  );

  const directDatabaseFullAccess = await callTool("update_page_access", {
    permissionId: directDatabasePermissionId,
    role: "full_access",
  });
  assertIncludes(directDatabaseFullAccess, "Full access", "direct database full_access update_page_access response");
  assertIncludes(
    directDatabaseFullAccess,
    "can manage sharing: yes",
    "direct database full_access update_page_access response",
  );
  const directDatabaseAccess = await callNotificationSourceTool("list_page_access", {
    pageId: databaseId,
  });
  assertIncludes(directDatabaseAccess, "can manage sharing: yes", "direct database list_page_access response");
  await assertWorkspaceAdminToolsDenied(
    callNotificationSourceToolResult,
    workspaceId,
    "direct database full_access non-member",
    `mcp-direct-database-full-access-denied-invite-${suffix}@example.com`,
  );
  const directDatabaseFullAccessRowTitle = `MCP direct database full access row ${suffix}`;
  const directDatabaseFullAccessRow = await callNotificationSourceTool("add_database_row", {
    databaseId,
    title: directDatabaseFullAccessRowTitle,
    empty: true,
    properties: {
      Status: "Done",
      Tags: ["Idea"],
      [scorePropertyName]: 5,
      [duePropertyName]: "2026-01-05",
      [lanePropertyName]: "Frontend",
    },
  });
  assertIncludes(directDatabaseFullAccessRow, "Created row", "direct database full_access add_database_row response");
  const directDatabaseFullAccessRowId = matchRequired(
    directDatabaseFullAccessRow,
    /row id:\s*([^\s]+)/,
    "direct database full_access row id",
  );
  const directDatabaseQueryAfterFullAccessWrite = await callNotificationSourceTool("query_database", {
    databaseId,
    search: directDatabaseFullAccessRowTitle,
  });
  assertIncludes(
    directDatabaseQueryAfterFullAccessWrite,
    directDatabaseFullAccessRowId,
    "direct database query after full_access write response",
  );
  assertIncludes(
    directDatabaseQueryAfterFullAccessWrite,
    directDatabaseFullAccessRowTitle,
    "direct database query after full_access write response",
  );

  const revokedDirectDatabaseAccess = await callTool("revoke_page_access", {
    permissionId: directDatabasePermissionId,
  });
  assertIncludes(revokedDirectDatabaseAccess, directDatabasePermissionId, "direct database revoke_page_access response");
  removeTrackedPermission(directDatabasePermissionId);

  const filteredViewName = `MCP Filtered View ${suffix}`;
  const createdFilteredView = await callTool("create_database_view", {
    databaseId,
    type: "table",
    name: filteredViewName,
    visibleProperties: ["Name", "Status", "Tags", scorePropertyName, duePropertyName],
    filters: [{ property: "Status", operator: "equals", value: "Done" }],
    sorts: [{ property: scorePropertyName, direction: "desc" }],
    tableCalculations: [{ property: scorePropertyName, calculation: "sum" }],
    rowHeight: "short",
  });
  assertIncludes(createdFilteredView, `Created view "${filteredViewName}"`, "create_database_view filtered response");
  assertIncludes(createdFilteredView, "filters: 1", "create_database_view filtered response");
  assertIncludes(createdFilteredView, `calculations: ${scorePropertyName} sum`, "create_database_view filtered response");
  assertIncludes(createdFilteredView, `sorts: ${scorePropertyName} desc`, "create_database_view filtered response");

  const queriedFilteredViewResult = await callToolResult("query_database", {
    databaseId,
    view: filteredViewName,
    limit: 10,
  });
  const queriedFilteredView = queriedFilteredViewResult.text;
  assertIncludes(queriedFilteredView, viewGammaRowId, "query_database filtered view response");
  assertIncludes(queriedFilteredView, viewAlphaRowId, "query_database filtered view response");
  assertNotIncludes(queriedFilteredView, viewBetaRowId, "query_database filtered view response");
  assertBefore(queriedFilteredView, viewGammaTitle, viewAlphaTitle, "query_database filtered view response");
  assertDatabaseQueryStructuredContent(
    queriedFilteredViewResult,
    {
      databaseId,
      viewName: filteredViewName,
      rowIds: [viewGammaRowId, viewAlphaRowId],
      columnNames: ["Name", "Status", "Tags", scorePropertyName, duePropertyName],
      cellTexts: [viewGammaTitle, viewAlphaTitle],
    },
    "query_database filtered view response",
  );

  const nestedFilterViewName = `MCP Nested Filter View ${suffix}`;
  const updatedFilteredView = await callTool("update_database_view", {
    databaseId,
    view: filteredViewName,
    name: nestedFilterViewName,
    sorts: [{ property: scorePropertyName, direction: "asc" }],
    filterGroup: {
      conjunction: "and",
      filters: [{ property: "Tags", operator: "equals", value: "Urgent" }],
      groups: [
        {
          conjunction: "or",
          filters: [
            { property: "Status", operator: "equals", value: "Done" },
            { property: "Status", operator: "equals", value: "In progress" },
          ],
        },
      ],
    },
  });
  assertIncludes(updatedFilteredView, `Updated view "${nestedFilterViewName}"`, "update_database_view nested response");
  assertIncludes(updatedFilteredView, "filters: 3", "update_database_view nested response");
  assertIncludes(updatedFilteredView, `sorts: ${scorePropertyName} asc`, "update_database_view nested response");

  const queriedNestedFilterView = await callTool("query_database", {
    databaseId,
    view: nestedFilterViewName,
    limit: 10,
  });
  assertIncludes(queriedNestedFilterView, viewBetaRowId, "query_database nested filter view response");
  assertIncludes(queriedNestedFilterView, viewGammaRowId, "query_database nested filter view response");
  assertNotIncludes(queriedNestedFilterView, viewAlphaRowId, "query_database nested filter view response");
  assertBefore(queriedNestedFilterView, viewBetaTitle, viewGammaTitle, "query_database nested filter view response");

  const configuredBoardViewName = `MCP Status Board ${suffix}`;
  const configuredBoardView = await callTool("create_database_view", {
    databaseId,
    type: "board",
    name: configuredBoardViewName,
    groupBy: "Status",
    subGroupBy: lanePropertyName,
    visibleProperties: ["Name", "Status", "Tags", lanePropertyName, scorePropertyName],
    cardSize: "small",
    openPageIn: "side",
  });
  assertIncludes(configuredBoardView, `Created view "${configuredBoardViewName}"`, "create_database_view board response");
  assertIncludes(configuredBoardView, "group: Status", "create_database_view board response");
  assertIncludes(configuredBoardView, `sub-group: ${lanePropertyName}`, "create_database_view board response");

  const calendarViewName = `MCP Calendar ${suffix}`;
  const calendarView = await callTool("create_database_view", {
    databaseId,
    type: "calendar",
    name: calendarViewName,
    calendarBy: duePropertyName,
    visibleProperties: ["Name", "Status", duePropertyName],
    openPageIn: "center",
  });
  assertIncludes(calendarView, `Created view "${calendarViewName}"`, "create_database_view calendar response");
  assertIncludes(calendarView, `calendar: ${duePropertyName}`, "create_database_view calendar response");

  const timelineViewName = `MCP Timeline ${suffix}`;
  const timelineView = await callTool("create_database_view", {
    databaseId,
    type: "timeline",
    name: timelineViewName,
    timelineBy: duePropertyName,
    visibleProperties: ["Name", "Status", duePropertyName],
    timelineZoom: "week",
    openPageIn: "full",
  });
  assertIncludes(timelineView, `Created view "${timelineViewName}"`, "create_database_view timeline response");
  assertIncludes(timelineView, `timeline: ${duePropertyName}`, "create_database_view timeline response");

  const initialTemplates = await callTool("list_database_templates", { databaseId });
  assertIncludes(initialTemplates, "No templates found", "list_database_templates initial response");

  const templateName = `MCP template ${suffix}`;
  const templateTitle = `MCP templated row ${suffix}`;
  const templateBody = `MCP template body ${suffix}`;
  const createdTemplate = await callTool("create_database_template", {
    databaseId,
    name: templateName,
    title: templateTitle,
    isDefault: true,
    properties: {
      Status: "Done",
      Tags: ["Urgent"],
    },
    content: `## ${templateBody}\n\n- created through MCP template tool`,
  });
  const templateId = matchRequired(createdTemplate, /template id:\s*([^\s]+)/, "created database template id");
  assertIncludes(createdTemplate, `Created template "${templateName}"`, "create_database_template response");
  assertIncludes(createdTemplate, "Set as default template", "create_database_template response");

  const listedTemplates = await callTool("list_database_templates", { databaseId });
  assertIncludes(listedTemplates, templateName, "list_database_templates response");
  assertIncludes(listedTemplates, "[default]", "list_database_templates response");
  assertIncludes(listedTemplates, templateId, "list_database_templates response");
  assertIncludes(listedTemplates, "blocks:", "list_database_templates response");

  const readTemplate = await callTool("get_database_template", { databaseId, templateId });
  assertIncludes(readTemplate, templateName, "get_database_template response");
  assertIncludes(readTemplate, "default: yes", "get_database_template response");
  assertIncludes(readTemplate, templateTitle, "get_database_template response");
  assertIncludes(readTemplate, "Status: Done", "get_database_template response");
  assertIncludes(readTemplate, "Tags: Urgent", "get_database_template response");
  assertIncludes(readTemplate, templateBody, "get_database_template response");

  const updatedTemplateName = `MCP template updated ${suffix}`;
  const updatedTemplateTitle = `MCP updated templated row ${suffix}`;
  const updatedTemplateBody = `MCP updated template body ${suffix}`;
  const updatedTemplate = await callTool("update_database_template", {
    databaseId,
    templateId,
    name: updatedTemplateName,
    title: updatedTemplateTitle,
    isDefault: true,
    properties: {
      Tags: ["Idea"],
    },
    content: `## ${updatedTemplateBody}\n\n- updated through MCP template tool`,
  });
  assertIncludes(updatedTemplate, `Updated template "${updatedTemplateName}"`, "update_database_template response");
  assertIncludes(updatedTemplate, templateId, "update_database_template response");

  const readUpdatedTemplate = await callTool("get_database_template", { databaseId, templateId });
  assertIncludes(readUpdatedTemplate, updatedTemplateName, "get_database_template after update response");
  assertIncludes(readUpdatedTemplate, "default: yes", "get_database_template after update response");
  assertIncludes(readUpdatedTemplate, updatedTemplateTitle, "get_database_template after update response");
  assertIncludes(readUpdatedTemplate, "Status: Done", "get_database_template after update response");
  assertIncludes(readUpdatedTemplate, "Tags: Idea", "get_database_template after update response");
  assertIncludes(readUpdatedTemplate, updatedTemplateBody, "get_database_template after update response");

  const duplicatedTemplateName = `MCP template copy ${suffix}`;
  const duplicatedTemplate = await callTool("duplicate_database_template", {
    databaseId,
    templateId,
    name: duplicatedTemplateName,
    isDefault: true,
  });
  const duplicatedTemplateId = matchRequired(
    duplicatedTemplate,
    /template id:\s*([^\s]+)/,
    "duplicated database template id",
  );
  assertIncludes(
    duplicatedTemplate,
    `Duplicated template "${updatedTemplateName}"`,
    "duplicate_database_template response",
  );
  assertIncludes(duplicatedTemplate, duplicatedTemplateName, "duplicate_database_template response");
  assertIncludes(duplicatedTemplate, "Set as default template", "duplicate_database_template response");

  const sourceAfterDuplicate = await callTool("get_database_template", { databaseId, templateId });
  assertIncludes(sourceAfterDuplicate, "default: no", "source get_database_template after duplicate response");

  const duplicatedTemplateRow = await callTool("add_database_row", {
    databaseId,
    templateId: duplicatedTemplateId,
  });
  const duplicatedTemplateRowId = matchRequired(
    duplicatedTemplateRow,
    /row id:\s*([^\s]+)/,
    "database row created from duplicated template id",
  );
  assertIncludes(
    duplicatedTemplateRow,
    `Created row "${updatedTemplateTitle}"`,
    "add_database_row duplicated template response",
  );
  assertIncludes(duplicatedTemplateRow, `Applied template: ${duplicatedTemplateName}`, "add_database_row duplicated template response");
  assertIncludes(duplicatedTemplateRow, "Added", "add_database_row duplicated template response");

  const queriedTemplateRows = await callTool("query_database", {
    databaseId,
    search: updatedTemplateTitle,
    limit: 5,
  });
  assertIncludes(queriedTemplateRows, duplicatedTemplateRowId, "query_database templated row response");
  assertIncludes(queriedTemplateRows, updatedTemplateTitle, "query_database templated row response");
  assertIncludes(queriedTemplateRows, "Done", "query_database templated row response");
  assertIncludes(queriedTemplateRows, "Idea", "query_database templated row response");

  const readTemplatedRow = await callTool("get_page", { pageId: duplicatedTemplateRowId });
  assertIncludes(readTemplatedRow, updatedTemplateTitle, "get_page templated row response");
  assertIncludes(readTemplatedRow, updatedTemplateBody, "get_page templated row response");

  const deletedSourceTemplate = await callTool("delete_database_template", {
    databaseId,
    templateId,
  });
  assertIncludes(
    deletedSourceTemplate,
    `Deleted template "${updatedTemplateName}"`,
    "delete_database_template source response",
  );

  const deletedDuplicatedTemplate = await callTool("delete_database_template", {
    databaseId,
    templateId: duplicatedTemplateId,
  });
  assertIncludes(
    deletedDuplicatedTemplate,
    `Deleted template "${duplicatedTemplateName}"`,
    "delete_database_template duplicate response",
  );

  const templatesAfterDelete = await callTool("list_database_templates", { databaseId });
  assertNotIncludes(templatesAfterDelete, templateId, "list_database_templates after delete response");
  assertNotIncludes(templatesAfterDelete, duplicatedTemplateId, "list_database_templates after delete response");

  const rowTitle = `MCP live smoke row ${suffix}`;
  const addedRow = await callTool("add_database_row", {
    databaseId,
    title: rowTitle,
    empty: true,
    properties: {
      Status: "In progress",
      Tags: ["Idea"],
    },
  });
  const rowId = matchRequired(addedRow, /row id:\s*([^\s]+)/, "created database row id");

  const updatedRowTitle = `MCP live smoke row updated ${suffix}`;
  const updatedRow = await callTool("update_database_row", {
    rowId,
    title: updatedRowTitle,
    properties: {
      Status: "Done",
      Tags: ["Idea"],
    },
  });
  assertIncludes(updatedRow, `Updated row "${updatedRowTitle}"`, "update_database_row response");
  assertIncludes(updatedRow, rowId, "update_database_row response");

  const queriedRows = await callTool("query_database", {
    databaseId,
    search: updatedRowTitle,
    limit: 5,
  });
  assertIncludes(queriedRows, rowId, "query_database response");
  assertIncludes(queriedRows, updatedRowTitle, "query_database response");
  assertIncludes(queriedRows, "Done", "query_database response");

  const rowPageBodyText = `MCP database row page body export ${suffix}`;
  const appendedRowBody = await callTool("add_content", {
    pageId: rowId,
    markdown: rowPageBodyText,
  });
  assertIncludes(appendedRowBody, "Appended", "add_content row page response");
  const rowChildTitle = `MCP database row child ${suffix}`;
  const rowChildBodyText = `MCP database row child body export ${suffix}`;
  const rowChildPage = await callTool("create_page", {
    title: rowChildTitle,
    parentId: rowId,
    content: rowChildBodyText,
  });
  const rowChildPageId = matchRequired(rowChildPage, /\(id:\s*([^)]+)\)/, "database row child page id");
  createdPageIds.push(rowChildPageId);

  const exportedDatabaseWithRowTree = await callTool("export_page_markdown", {
    pageId: databaseId,
  }, 20000);
  assertIncludes(exportedDatabaseWithRowTree, `## ${updatedRowTitle}`, "export_page_markdown row page tree response");
  assertIncludes(exportedDatabaseWithRowTree, rowPageBodyText, "export_page_markdown row page tree response");
  assertIncludes(exportedDatabaseWithRowTree, `### ${rowChildTitle}`, "export_page_markdown row child tree response");
  assertIncludes(exportedDatabaseWithRowTree, rowChildBodyText, "export_page_markdown row child tree response");

  const exportedWorkspaceWithRowTree = await callTool("export_workspace_markdown", {
    workspaceId,
  }, 20000);
  assertIncludes(exportedWorkspaceWithRowTree, `### ${updatedRowTitle}`, "export_workspace_markdown row page tree response");
  assertIncludes(exportedWorkspaceWithRowTree, rowPageBodyText, "export_workspace_markdown row page tree response");
  assertIncludes(exportedWorkspaceWithRowTree, `#### ${rowChildTitle}`, "export_workspace_markdown row child tree response");
  assertIncludes(exportedWorkspaceWithRowTree, rowChildBodyText, "export_workspace_markdown row child tree response");

  const trashedRow = await callTool("trash_database_row", { rowId });
  assertIncludes(trashedRow, `Moved row "${updatedRowTitle}"`, "trash_database_row response");
  assertIncludes(trashedRow, "to trash", "trash_database_row response");

  const rowsAfterTrash = await callTool("query_database", {
    databaseId,
    search: updatedRowTitle,
    limit: 5,
  });
  assertNotIncludes(rowsAfterTrash, rowId, "query_database after trash_database_row response");

  const restoredRow = await callTool("restore_database_row", { rowId });
  assertIncludes(restoredRow, `Restored row "${updatedRowTitle}"`, "restore_database_row response");

  const rowsAfterRestore = await callTool("query_database", {
    databaseId,
    search: updatedRowTitle,
    limit: 5,
  });
  assertIncludes(rowsAfterRestore, rowId, "query_database after restore_database_row response");

  const retrashRow = await callTool("trash_database_row", { rowId });
  assertIncludes(retrashRow, `Moved row "${updatedRowTitle}"`, "trash_database_row before delete response");

  const deletedRow = await callTool("delete_database_row_forever", { rowId });
  assertIncludes(deletedRow, `Deleted row "${updatedRowTitle}"`, "delete_database_row_forever response");
  assertIncludes(deletedRow, "cleaned blocks:", "delete_database_row_forever response");

  await cleanupCreatedPages();
  createdPageIds.length = 0;

  console.log(`MCP live smoke ok against ${baseUrl}`);
} catch (error) {
  if (policyStderr.trim()) {
    console.error(policyStderr.trim());
  }
  if (emailShareStderr.trim()) {
    console.error(emailShareStderr.trim());
  }
  if (notificationSourceStderr.trim()) {
    console.error(notificationSourceStderr.trim());
  }
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await cleanupCreatedFileUploads().catch(() => {});
  await cleanupCreatedPermissions().catch(() => {});
  await cleanupCreatedPages().catch(() => {});
  await cleanupCreatedWorkspaces().catch(() => {});
  await cleanupNotificationSourcePermissions().catch(() => {});
  await cleanupNotificationSourcePages().catch(() => {});
  await closePolicyClient().catch(() => {});
  await closeEmailShareClient().catch(() => {});
  await closeNotificationSourceClient().catch(() => {});
  cleanupTempPolicyFiles();
  await client?.close().catch(() => {});
  await transport?.close().catch(() => {});
  await cleanupSmokeAccounts().catch((error) => {
    console.error(`FAIL MCP smoke account cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode ||= 1;
  });
}
