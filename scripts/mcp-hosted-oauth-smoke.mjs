#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.NOTIONLIKE_SMOKE_BASE_URL ?? "http://127.0.0.1:8787";

function argValue(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

function resolveUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`${url} did not return JSON: ${text.slice(0, 200)}`);
  }
  return { response, json, text };
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  return { response, text };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function randomBase64Url(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function sha256Base64Url(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Buffer.from(new Uint8Array(digest))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

const baseUrl = argValue("--url", DEFAULT_BASE_URL);

const protectedResourceUrl = resolveUrl(baseUrl, "/api/functions/mcp-oauth-protected-resource");
const authServerUrl = resolveUrl(baseUrl, "/api/functions/mcp-oauth-authorization-server");
const connectionsUrl = resolveUrl(baseUrl, "/api/functions/mcp-connections");
const mcpUrl = resolveUrl(baseUrl, "/api/functions/mcp");
const registerUrl = resolveUrl(baseUrl, "/api/functions/mcp-oauth-register");
const tokenUrl = resolveUrl(baseUrl, "/api/functions/mcp-oauth-token");

const protectedResource = await fetchJson(protectedResourceUrl, {
  headers: { Accept: "application/json" },
});
assert(protectedResource.response.ok, `protected resource metadata returned HTTP ${protectedResource.response.status}`);
assert(protectedResource.json.resource === mcpUrl, "protected resource metadata must name the hosted MCP endpoint as resource");
assert(
  Array.isArray(protectedResource.json.authorization_servers) &&
    protectedResource.json.authorization_servers.includes(new URL(baseUrl).origin),
  "protected resource metadata must advertise the local authorization server",
);
assert(
  protectedResource.json.scopes_supported?.includes("pages:read") &&
    protectedResource.json.scopes_supported?.includes("databases:write"),
  "protected resource metadata must advertise Hanji MCP scopes",
);

const authServer = await fetchJson(authServerUrl, {
  headers: { Accept: "application/json" },
});
assert(authServer.response.ok, `authorization server metadata returned HTTP ${authServer.response.status}`);
assert(authServer.json.authorization_endpoint?.endsWith("/api/functions/mcp-oauth-authorize"), "authorization endpoint missing");
assert(authServer.json.token_endpoint?.endsWith("/api/functions/mcp-oauth-token"), "token endpoint missing");
assert(authServer.json.registration_endpoint?.endsWith("/api/functions/mcp-oauth-register"), "registration endpoint missing");
assert(authServer.json.code_challenge_methods_supported?.includes("S256"), "PKCE S256 support missing");

const unauthenticated = await fetchJson(mcpUrl, {
  method: "POST",
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Mcp-Protocol-Version": "2025-11-25",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
});
assert(unauthenticated.response.status === 401, `/mcp without token must return 401, got ${unauthenticated.response.status}`);
const challenge = unauthenticated.response.headers.get("www-authenticate") ?? "";
assert(challenge.includes("resource_metadata="), "unauthenticated /mcp must include resource_metadata challenge");
assert(challenge.includes(protectedResourceUrl), "challenge must point to hosted MCP protected resource metadata");

let seed = null;
try {
  seed = await seedAccountAndWorkspace(baseUrl);
  const connection = await callFunction(connectionsUrl, seed.accessToken, {
    action: "createManualToken",
    clientName: "Hosted MCP smoke",
  });
  assert(connection.response.ok, `mcp-connections createManualToken returned HTTP ${connection.response.status}`);
  assert(connection.json.mcpServerUrl === mcpUrl, "mcp-connections must return the hosted MCP URL");
  assert(typeof connection.json.createdToken?.accessToken === "string", "manual token flow must return an access token");
  assert(typeof connection.json.createdToken?.refreshToken === "string", "manual token flow must return a refresh token");
  assert(connection.json.grants?.some((grant) => grant.id === connection.json.createdToken.grant?.id), "manual token grant must be listed");

  const initialize = await callMcp(connection.json.createdToken.accessToken, {
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {},
  });
  assert(
    initialize.response.ok,
    `authenticated MCP initialize returned HTTP ${initialize.response.status}: ${initialize.text}`,
  );
  assert(initialize.json.result?.serverInfo?.name === "hanji-hosted-mcp", "MCP initialize must return hosted serverInfo");

  const listWorkspaces = await callMcp(connection.json.createdToken.accessToken, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_workspaces", arguments: {} },
  });
  assert(listWorkspaces.response.ok, `authenticated MCP list_workspaces returned HTTP ${listWorkspaces.response.status}`);
  const workspaces = listWorkspaces.json.result?.structuredContent?.workspaces ?? [];
  assert(
    Array.isArray(workspaces) && workspaces.some((workspace) => workspace.id === seed.workspaceId),
    "list_workspaces must include the seeded workspace",
  );

  const oauthAccessToken = await runAuthorizationCodeFlow(seed);
  const oauthInitialize = await callMcp(oauthAccessToken, {
    jsonrpc: "2.0",
    id: 4,
    method: "initialize",
    params: {},
  });
  assert(oauthInitialize.response.ok, `OAuth MCP initialize returned HTTP ${oauthInitialize.response.status}`);
  assert(oauthInitialize.json.result?.serverInfo?.name === "hanji-hosted-mcp", "OAuth token must initialize hosted MCP");

  const selectedWorkspaceAccessToken = await runAuthorizationCodeFlow(seed, { workspaceAccess: "selected" });
  const selectedPolicy = await mcpTool(selectedWorkspaceAccessToken, "get_mcp_access_policy");
  assert(selectedPolicy.grant?.workspaceAccess === "selected", "selected OAuth consent must create a selected-workspace grant");
  assert(
    Array.isArray(selectedPolicy.grant?.workspaceIds) && selectedPolicy.grant.workspaceIds.includes(seed.workspaceId),
    "selected OAuth consent must store the selected workspace id",
  );

  await verifyHostedMcpCoreTools(connection.json.createdToken.accessToken, seed.workspaceId);
} finally {
  if (seed) await cleanupSeed(baseUrl, seed).catch(() => {});
}

console.log(`PASS hosted MCP OAuth discovery, browser bridge, full/selected consent, token grants, manual token grant, and official Notion-compatible hosted MCP tool surface at ${baseUrl}`);

function richText(content) {
  return [{ type: "text", text: { content }, plain_text: content }];
}

async function mcpTool(accessToken, name, args = {}) {
  const response = await callMcp(accessToken, {
    jsonrpc: "2.0",
    id: Math.floor(Math.random() * 1_000_000),
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert(response.response.ok, `${name} returned HTTP ${response.response.status}: ${response.text}`);
  const result = response.json.result;
  assert(result && typeof result === "object", `${name} must return a JSON-RPC result`);
  assert(result.isError !== true, `${name} returned tool error: ${result.content?.[0]?.text ?? response.text}`);
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
}

async function verifyHostedMcpCoreTools(accessToken, workspaceId) {
  const listed = await callMcp(accessToken, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/list",
    params: {},
  });
  assert(listed.response.ok, `tools/list returned HTTP ${listed.response.status}`);
  const toolNames = new Set((listed.json.result?.tools ?? []).map((tool) => tool.name));
  for (const name of [
    "notion-search",
    "notion-fetch",
    "notion-create-pages",
    "notion-update-page",
    "notion-move-pages",
    "notion-duplicate-page",
    "notion-create-database",
    "notion-update-data-source",
    "notion-create-view",
    "notion-update-view",
    "notion-query-data-sources",
    "notion-query-database-view",
    "notion-query-meeting-notes",
    "notion-create-comment",
    "notion-get-comments",
    "notion-get-teams",
    "notion-get-users",
    "notion-get-async-task",
    "_search",
    "_fetch",
    "_notion_query_data_sources",
    "_notion_create_pages",
    "_notion_update_page",
    "_notion_duplicate_page",
    "_notion_move_pages",
    "_notion_create_database",
    "_notion_get_users",
    "_notion_get_teams",
  ]) {
    assert(toolNames.has(name), `hosted MCP tools/list must include ${name}`);
  }

  const unique = `Hosted MCP Smoke ${Date.now()}`;
  const self = await mcpTool(accessToken, "notion-fetch", {
    workspace_id: workspaceId,
    id: "self",
  });
  assert(self.self?.workspace?.id === workspaceId, "notion-fetch self must return the selected workspace identity");

  const createdPageTask = await mcpTool(accessToken, "notion-create-pages", {
    workspace_id: workspaceId,
    allow_async: true,
    pages: [
      {
        properties: { title: unique },
        content: `# ${unique}\n\nThis page was created through hosted MCP.`,
      },
    ],
  });
  const createdPagePolled = await mcpTool(accessToken, "notion-get-async-task", {
    task_id: createdPageTask.async_task?.id,
  });
  const createdPage = createdPagePolled.async_task?.result;
  const pageId = createdPage.pages?.[0]?.id;
  assert(typeof pageId === "string" && pageId, "notion-create-pages async task must return created page id");

  const updateTask = await mcpTool(accessToken, "notion-update-page", {
    workspace_id: workspaceId,
    page_id: pageId,
    allow_async: true,
    command: "insert_content",
    new_str: `- [ ] Async update marker for ${unique}`,
  });
  const updatePolled = await mcpTool(accessToken, "notion-get-async-task", {
    task_id: updateTask.async_task?.id,
  });
  assert(updatePolled.async_task?.status === "succeeded", "notion-update-page async task must succeed");

  const search = await mcpTool(accessToken, "notion-search", {
    workspace_id: workspaceId,
    query: unique,
    page_size: 10,
  });
  assert(
    Array.isArray(search.results) && search.results.some((item) => item.id === pageId),
    "_search must find a page created through hosted MCP",
  );

  const fetched = await mcpTool(accessToken, "notion-fetch", {
    workspace_id: workspaceId,
    id: pageId,
  });
  assert(fetched.page?.id === pageId, "_fetch must return the created page");
  assert(Array.isArray(fetched.blocks?.results), "_fetch must include page block children");

  const comment = await mcpTool(accessToken, "notion-create-comment", {
    workspace_id: workspaceId,
    page_id: pageId,
    text: `Comment from hosted MCP smoke ${unique}`,
  });
  assert(comment.id, "notion-create-comment must create a comment");

  const comments = await mcpTool(accessToken, "notion-get-comments", {
    workspace_id: workspaceId,
    page_id: pageId,
  });
  assert(
    Array.isArray(comments.results) && comments.results.some((item) => item.id === comment.id),
    "notion-get-comments must return a comment created through hosted MCP",
  );

  const duplicatedTask = await mcpTool(accessToken, "notion-duplicate-page", {
    workspace_id: workspaceId,
    page_id: pageId,
    title: `${unique} Copy`,
  });
  const duplicatedPolled = await mcpTool(accessToken, "notion-get-async-task", {
    task_id: duplicatedTask.async_task?.id,
  });
  const duplicated = duplicatedPolled.async_task?.result;
  const duplicatedPageId = duplicated.page?.id;
  assert(typeof duplicatedPageId === "string" && duplicatedPageId, "notion-duplicate-page must return copied page id through an async task");

  const moved = await mcpTool(accessToken, "notion-move-pages", {
    workspace_id: workspaceId,
    page_id: duplicatedPageId,
    new_parent: { type: "page_id", page_id: pageId },
  });
  assert(
    Array.isArray(moved.moved) &&
      moved.moved.some((item) => item.id === duplicatedPageId && item.parent?.id === pageId),
    "_notion_move_pages must move the duplicated page under the requested parent",
  );

  const teams = await mcpTool(accessToken, "notion-get-teams", {
    query: "",
  });
  assert(
    Array.isArray(teams.results) && teams.results.some((item) => item.workspace_id === workspaceId),
    "notion-get-teams must list the selected workspace as a teamspace",
  );

  const users = await mcpTool(accessToken, "notion-get-users", {
    workspace_id: workspaceId,
    page_size: 10,
  });
  assert(Array.isArray(users.results) && users.results.length > 0, "notion-get-users must list workspace users");

  const createdDatabase = await mcpTool(accessToken, "notion-create-database", {
    workspace_id: workspaceId,
    title: `${unique} Tasks`,
    properties: {
      Name: { title: {} },
      Status: {
        select: {
          options: [
            { name: "진행", color: "blue" },
            { name: "완료", color: "green" },
          ],
        },
      },
    },
  });
  const databaseId = createdDatabase.id;
  assert(typeof databaseId === "string" && databaseId, "_notion_create_database must return database id");

  const updatedDatabase = await mcpTool(accessToken, "notion-update-data-source", {
    workspace_id: workspaceId,
    data_source_id: databaseId,
    name: `${unique} Tasks Updated`,
  });
  assert(updatedDatabase.id === databaseId, "notion-update-data-source must update the database/data source");

  const rowTitle = `${unique} 과제`;
  const createdRow = await mcpTool(accessToken, "notion-create-pages", {
    workspace_id: workspaceId,
    parent: { data_source_id: databaseId },
    pages: [
      {
        properties: {
          Name: { title: richText(rowTitle) },
          Status: { select: { name: "진행" } },
        },
      },
    ],
  });
  const rowId = createdRow.pages?.[0]?.id;
  assert(typeof rowId === "string" && rowId, "_notion_create_pages must create database rows");

  const queried = await mcpTool(accessToken, "notion-query-data-sources", {
    data: {
      workspace_id: workspaceId,
      data_source_id: databaseId,
      query: rowTitle,
      page_size: 10,
    },
  });
  assert(
    Array.isArray(queried.results) && queried.results.some((item) => item.id === rowId),
    "_notion_query_data_sources must return a row created through hosted MCP",
  );

  const createdView = await mcpTool(accessToken, "notion-create-view", {
    workspace_id: workspaceId,
    data_source_id: databaseId,
    name: `${unique} View`,
    type: "table",
  });
  assert(typeof createdView.id === "string" && createdView.id, "notion-create-view must return view id");

  const queriedView = await mcpTool(accessToken, "notion-query-database-view", {
    workspace_id: workspaceId,
    view_id: createdView.id,
    page_size: 10,
  });
  assert(
    Array.isArray(queriedView.results) && queriedView.results.some((item) => item.id === rowId),
    "notion-query-database-view must return rows from the saved view",
  );

  const updatedView = await mcpTool(accessToken, "notion-update-view", {
    workspace_id: workspaceId,
    view_id: createdView.id,
    name: `${unique} View Renamed`,
  });
  assert(updatedView.id === createdView.id, "notion-update-view must update a view");

  const meetingNotes = await mcpTool(accessToken, "notion-query-meeting-notes", {
    workspace_id: workspaceId,
  });
  assert(meetingNotes.is_unsupported === true, "notion-query-meeting-notes must return an explicit unsupported response");
}

async function runAuthorizationCodeFlow(seed, options = {}) {
  const workspaceAccess = options.workspaceAccess ?? "all_accessible";
  const redirectUri = resolveUrl(baseUrl, "/mcp-oauth-smoke-callback");
  const registered = await fetchJson(registerUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Hosted MCP OAuth smoke",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  assert(registered.response.status === 201, `dynamic client registration returned HTTP ${registered.response.status}`);
  const clientId = registered.json.client_id;
  assert(typeof clientId === "string" && clientId, "dynamic client registration must return client_id");

  const codeVerifier = randomBase64Url(48);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const state = `state-${randomBase64Url(12)}`;
  const authorizeUrl = new URL(resolveUrl(baseUrl, "/api/functions/mcp-oauth-authorize"));
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("resource", mcpUrl);
  authorizeUrl.searchParams.set("scope", "pages:read workspace:read");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  const browserEntry = await fetchText(authorizeUrl.toString(), {
    headers: { Accept: "text/html" },
  });
  assert(browserEntry.response.ok, `browser authorize entry returned HTTP ${browserEntry.response.status}`);
  assert(browserEntry.text.includes("Hanji 세션 확인 중"), "browser authorize entry must render the local-session bridge");

  const refreshed = await fetchJson(resolveUrl(baseUrl, "/api/auth/refresh"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: seed.refreshToken }),
  });
  assert(refreshed.response.ok, `auth refresh for browser bridge returned HTTP ${refreshed.response.status}`);
  const accessToken = refreshed.json.accessToken;
  assert(typeof accessToken === "string" && accessToken, "auth refresh must return accessToken");

  const consent = await fetchText(authorizeUrl.toString(), {
    headers: {
      Accept: "text/html",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  assert(consent.response.ok, `authorized consent page returned HTTP ${consent.response.status}`);
  assert(consent.text.includes("AI 앱 연결 허용"), "authorized consent page must render consent UI");
  assert(consent.text.includes("내가 접근 가능한 전체 워크스페이스"), "consent UI must default to all accessible workspaces");
  assert(consent.text.includes("특정 워크스페이스만 선택"), "consent UI must allow selected workspace grants");
  assert(consent.text.includes(seed.workspaceId), "consent UI must list the accessible workspace id");

  const form = new URLSearchParams();
  form.set("client_id", clientId);
  form.set("redirect_uri", redirectUri);
  form.set("state", state);
  form.set("resource", mcpUrl);
  form.set("code_challenge", codeChallenge);
  form.set("code_challenge_method", "S256");
  form.set("workspace_access", workspaceAccess);
  if (workspaceAccess === "selected") form.set(`workspace:${seed.workspaceId}`, "1");
  form.set("scope:pages:read", "1");
  form.set("scope:workspace:read", "1");
  form.set("decision", "approve");
  form.set("bridge", "1");

  const approval = await fetchJson(authorizeUrl.toString(), {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  assert(approval.response.ok, `consent approval returned HTTP ${approval.response.status}: ${approval.text}`);
  assert(typeof approval.json.redirect_to === "string", "consent approval bridge must return redirect_to");
  const redirect = new URL(approval.json.redirect_to);
  assert(redirect.searchParams.get("state") === state, "authorization redirect must preserve state");
  const code = redirect.searchParams.get("code");
  assert(code, "authorization redirect must include code");

  const token = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
    }),
  });
  assert(token.response.ok, `token exchange returned HTTP ${token.response.status}: ${token.text}`);
  assert(token.json.token_type === "Bearer", "token exchange must return Bearer token");
  assert(typeof token.json.access_token === "string" && token.json.access_token, "token exchange must return access_token");
  assert(typeof token.json.refresh_token === "string" && token.json.refresh_token, "token exchange must return refresh_token");

  // Refresh grant must rotate: the response carries a new refresh token, and
  // replaying the consumed one must fail (reuse detection).
  const rotatedToken = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: token.json.refresh_token,
    }),
  });
  assert(rotatedToken.response.ok, `refresh grant returned HTTP ${rotatedToken.response.status}: ${rotatedToken.text}`);
  assert(typeof rotatedToken.json.access_token === "string" && rotatedToken.json.access_token, "refresh grant must return access_token");
  assert(
    typeof rotatedToken.json.refresh_token === "string" && rotatedToken.json.refresh_token && rotatedToken.json.refresh_token !== token.json.refresh_token,
    "refresh grant must rotate the refresh token",
  );
  const replayed = await fetchJson(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: token.json.refresh_token,
    }),
  });
  assert(replayed.response.status === 400, `replaying a rotated refresh token must return 400, got HTTP ${replayed.response.status}`);
  assert(replayed.json.error === "invalid_grant", "replaying a rotated refresh token must return invalid_grant");

  return rotatedToken.json.access_token;
}

async function seedAccountAndWorkspace(baseUrl) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const signup = await fetchJson(resolveUrl(baseUrl, "/api/auth/signup"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `mcp-hosted-smoke-${suffix}@example.com`,
      password: `McpHostedSmoke${suffix}!aA1`,
      data: { displayName: "Hosted MCP Smoke" },
    }),
  });
  assert(signup.response.ok || signup.response.status === 201, `signup returned HTTP ${signup.response.status}`);
  assert(typeof signup.json?.accessToken === "string", "signup must return accessToken");
  assert(typeof signup.json?.refreshToken === "string", "signup must return refreshToken");

  const bootstrap = await callFunction(resolveUrl(baseUrl, "/api/functions/workspace-bootstrap"), signup.json.accessToken, {});
  assert(bootstrap.response.ok, `workspace-bootstrap returned HTTP ${bootstrap.response.status}`);
  assert(typeof bootstrap.json?.workspace?.id === "string", "workspace-bootstrap must return workspace.id");
  return {
    accessToken: signup.json.accessToken,
    refreshToken: signup.json.refreshToken,
    workspaceId: bootstrap.json.workspace.id,
  };
}

async function cleanupSeed(baseUrl, seed) {
  const list = await callFunction(resolveUrl(baseUrl, "/api/functions/workspace-mutation"), seed.accessToken, {
    action: "list",
  });
  if (!list.response.ok) return;
  const workspaces = Array.isArray(list.json?.workspaces) ? list.json.workspaces : [];
  for (const workspace of workspaces) {
    if (!workspace?.id) continue;
    await callFunction(resolveUrl(baseUrl, "/api/functions/workspace-mutation"), seed.accessToken, {
      action: "deleteWorkspace",
      workspaceId: workspace.id,
    }).catch(() => {});
  }
}

async function callFunction(url, token, body) {
  return await fetchJson(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
}

async function callMcp(accessToken, body) {
  return await fetchJson(mcpUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Mcp-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}
