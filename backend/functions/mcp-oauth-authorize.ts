import { defineFunction } from '@edge-base/shared';
import { bestEffort } from '../lib/table-utils';
import { fetchPublicResource, normalizePublicUrl } from '../lib/ssrf-guard';
import {
  MCP_DEFAULT_SCOPES,
  type DbRef,
  type McpOAuthAuthorizationCode,
  type McpOAuthClient,
  type McpOAuthGrant,
  type Workspace,
  authorizationCodeExpiresAt,
  accessibleWorkspaces,
  endpointUrls,
  escapeHtml,
  findClient,
  htmlPage,
  json,
  normalizeScopes,
  nowIso,
  randomToken,
  readOnlyFromScopes,
  redirectWithParams,
  requestBody,
  sha256Base64Url,
  stringList,
  stringValue,
  validateRedirectUri,
} from '../lib/mcp-oauth';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  auth: { id: string; email?: string | null } | null;
  admin: {
    db(namespace: string): DbRef;
  };
}

function paramsFromRequest(request: Request) {
  const url = new URL(request.url);
  return Object.fromEntries(url.searchParams.entries());
}

function hidden(name: string, value: unknown) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function redirectTarget(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function oauthRedirect(request: Request, body: Record<string, unknown>, redirectUri: string, params: Record<string, string | undefined>) {
  const target = redirectTarget(redirectUri, params);
  if (stringValue(body.bridge) === '1' || request.headers.get('Accept')?.includes('application/json')) {
    return json({ redirect_to: target });
  }
  return redirectWithParams(redirectUri, params);
}

function scopeLabel(scope: string) {
  const labels: Record<string, string> = {
    'pages:read': '페이지 읽기',
    'pages:write': '페이지 생성 및 수정',
    'databases:read': '데이터베이스 읽기',
    'databases:write': '데이터베이스 생성 및 수정',
    'comments:read': '댓글 읽기',
    'comments:write': '댓글 작성',
    'files:read': '파일 목록/다운로드 읽기',
    'files:write': '파일 업로드/삭제',
    'workspace:read': '워크스페이스 목록 읽기',
  };
  return labels[scope] ?? scope;
}

// Fetch and validate a Client ID Metadata Document (CIMD). The client_id is an
// HTTPS URL that must resolve to a JSON document declaring the client's allowed
// redirect_uris. Fetched through the SSRF guard (the client_id URL is
// caller-controlled), and the requested redirect_uri is validated against the
// document's declared set — never accepted on scheme alone.
async function fetchClientMetadata(clientId: string): Promise<{ redirectUris: string[]; clientName?: string }> {
  if (!normalizePublicUrl(clientId)) {
    throw new Error('client_id URL is not allowed.');
  }
  let response: Response;
  try {
    response = await fetchPublicResource(clientId, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('Client ID metadata document could not be fetched.');
  }
  if (!response.ok) {
    throw new Error('Client ID metadata document could not be fetched.');
  }
  let doc: unknown;
  try {
    doc = await response.json();
  } catch {
    throw new Error('Client ID metadata document is not valid JSON.');
  }
  const record = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {};
  // If the document declares its own client_id it must match the URL it was
  // fetched from, so a document cannot impersonate another client.
  if (typeof record.client_id === 'string' && record.client_id !== clientId) {
    throw new Error('Client ID metadata document client_id does not match.');
  }
  const redirectUris = stringList(record.redirect_uris);
  if (!redirectUris.length) {
    throw new Error('Client ID metadata document declares no redirect_uris.');
  }
  return {
    redirectUris,
    clientName: typeof record.client_name === 'string' ? record.client_name : undefined,
  };
}

async function resolveClient(db: DbRef, clientId: string, redirectUri: string) {
  const client = await findClient(db, clientId);
  if (client) {
    validateRedirectUri(client, redirectUri);
    return client;
  }

  // Client ID Metadata Document clients identify themselves with an HTTPS URL.
  let parsed: URL | null = null;
  try {
    parsed = new URL(clientId);
  } catch {
    parsed = null;
  }
  if (parsed && parsed.protocol === 'https:') {
    const metadata = await fetchClientMetadata(clientId);
    // Validate against the document's declared redirect_uris (registered-client
    // rules): scheme check plus exact-match membership. An arbitrary HTTPS
    // redirect is no longer accepted for CIMD clients.
    validateRedirectUri({ redirectUris: metadata.redirectUris } as McpOAuthClient, redirectUri);
    return {
      id: clientId,
      clientId,
      clientName: metadata.clientName ?? parsed.hostname,
      redirectUris: metadata.redirectUris,
      status: 'active',
    } satisfies McpOAuthClient;
  }
  throw new Error('MCP OAuth client is not registered.');
}

function validateAuthorizeParams(input: Record<string, unknown>, urls: ReturnType<typeof endpointUrls>) {
  const responseType = stringValue(input.response_type);
  if (responseType !== 'code') throw new Error('response_type must be code.');
  const clientId = stringValue(input.client_id);
  if (!clientId) throw new Error('client_id is required.');
  const redirectUri = stringValue(input.redirect_uri);
  if (!redirectUri) throw new Error('redirect_uri is required.');
  const codeChallenge = stringValue(input.code_challenge);
  if (!codeChallenge) throw new Error('code_challenge is required.');
  const method = stringValue(input.code_challenge_method, 'S256').toUpperCase();
  if (method !== 'S256') throw new Error('Only S256 PKCE is supported.');
  const resource = stringValue(input.resource, urls.resource);
  if (resource !== urls.resource) throw new Error('resource does not match this MCP server.');
  return {
    responseType,
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: method,
    state: stringValue(input.state),
    resource,
    requestedScopes: normalizeScopes(input.scope, MCP_DEFAULT_SCOPES),
  };
}

function consentBridgeScript() {
  return `<script>
(() => {
  const form = document.querySelector('form[data-mcp-consent]');
  if (!(form instanceof HTMLFormElement)) return;
  const status = document.querySelector('[data-mcp-status]');
  const setStatus = (message) => {
    if (status) status.textContent = message;
  };
  async function accessTokenFromBrowserSession() {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'X-EdgeBase-Auth-Transport': 'cookie',
      },
      body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.accessToken) throw new Error(body.error_description || body.error || 'Hanji 로그인 세션을 확인할 수 없습니다.');
    return body.accessToken;
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setStatus('Hanji 권한을 확인하는 중...');
    try {
      const accessToken = await accessTokenFromBrowserSession();
      const body = new URLSearchParams(new FormData(form));
      const submitter = event.submitter;
      if (submitter instanceof HTMLButtonElement && submitter.name) {
        body.set(submitter.name, submitter.value);
      }
      body.set('bridge', '1');
      const response = await fetch(window.location.href, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Authorization': \`Bearer \${accessToken}\`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json.redirect_to) throw new Error(json.error_description || json.error || 'MCP 연결을 완료할 수 없습니다.');
      window.location.assign(json.redirect_to);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });
})();
</script>`;
}

function loginBridgePage(urls: ReturnType<typeof endpointUrls>) {
  return htmlPage(
    'Hanji MCP 연결 확인',
    `
      <h1>Hanji 세션 확인 중</h1>
      <p data-mcp-login-status>로그인 상태를 확인해서 AI 앱 연결 승인 화면을 준비하고 있습니다.</p>
      <p class="muted">MCP 서버: <code>${escapeHtml(urls.resource)}</code></p>
      <p><a href="/">Hanji 열기</a></p>
      <script>
      (async () => {
        const status = document.querySelector('[data-mcp-login-status]');
        const setStatus = (message) => {
          if (status) status.textContent = message;
        };
        try {
          const refresh = await fetch('/api/auth/refresh', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'X-EdgeBase-Auth-Transport': 'cookie',
            },
            body: '{}',
          });
          const session = await refresh.json().catch(() => ({}));
          if (!refresh.ok || !session.accessToken) throw new Error(session.error_description || session.error || 'Hanji 로그인 세션을 갱신할 수 없습니다.');
          const consent = await fetch(window.location.href, {
            headers: {
              'Accept': 'text/html',
              'Authorization': \`Bearer \${session.accessToken}\`,
            },
          });
          const html = await consent.text();
          document.open();
          document.write(html);
          document.close();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      })();
      </script>
    `,
  );
}

function renderConsent(
  params: ReturnType<typeof validateAuthorizeParams>,
  client: McpOAuthClient,
  workspaces: Workspace[],
  userEmail?: string | null,
) {
  const scopeInputs = params.requestedScopes.map((scope) => `
      <label>
        <input type="checkbox" name="scope:${escapeHtml(scope)}" value="1" checked />
        <span>${escapeHtml(scopeLabel(scope))}<br /><span class="muted">${escapeHtml(scope)}</span></span>
      </label>`).join('');
  const workspaceInputs = workspaces.length
    ? workspaces.map((workspace) => `
      <label>
        <input type="checkbox" name="workspace:${escapeHtml(workspace.id)}" value="1" checked data-mcp-workspace disabled />
        <span>${escapeHtml(workspace.name || workspace.domain || 'Untitled Workspace')}<br /><span class="muted">${escapeHtml(workspace.id)}</span></span>
      </label>`).join('')
    : '<p class="muted">연결할 수 있는 워크스페이스가 없습니다.</p>';
  return htmlPage(
    'Hanji MCP 연결 허용',
    `
      <h1>AI 앱 연결 허용</h1>
      <p><strong>${escapeHtml(client.clientName ?? client.clientId)}</strong>에서 Hanji MCP에 접근하려고 합니다.</p>
      <p class="muted">로그인 계정: ${escapeHtml(userEmail || '현재 Hanji 계정')}</p>
      <form method="post" data-mcp-consent>
        ${hidden('client_id', params.clientId)}
        ${hidden('redirect_uri', params.redirectUri)}
        ${hidden('state', params.state)}
        ${hidden('resource', params.resource)}
        ${hidden('code_challenge', params.codeChallenge)}
        ${hidden('code_challenge_method', params.codeChallengeMethod)}
        <fieldset>
          <legend>접근 범위</legend>
          <label>
            <input type="radio" name="workspace_access" value="all_accessible" checked />
            <span>내가 접근 가능한 전체 워크스페이스<br /><span class="muted">새로 접근 권한을 얻는 워크스페이스도 현재 제품 권한 안에서만 허용됩니다.</span></span>
          </label>
          <label>
            <input type="radio" name="workspace_access" value="selected" />
            <span>특정 워크스페이스만 선택</span>
          </label>
          <div>
            ${workspaceInputs}
          </div>
        </fieldset>
        <fieldset>
          <legend>권한</legend>
          ${scopeInputs}
        </fieldset>
        <div class="actions">
          <button type="submit" name="decision" value="deny">거부</button>
          <button class="primary" type="submit" name="decision" value="approve">허용</button>
        </div>
        <p class="muted" data-mcp-status></p>
      </form>
      <script>
      (() => {
        const form = document.querySelector('form[data-mcp-consent]');
        if (!(form instanceof HTMLFormElement)) return;
        const workspaceInputs = Array.from(form.querySelectorAll('[data-mcp-workspace]'));
        const sync = () => {
          const selected = new FormData(form).get('workspace_access') === 'selected';
          for (const input of workspaceInputs) input.disabled = !selected;
        };
        form.addEventListener('change', sync);
        sync();
      })();
      </script>
      ${consentBridgeScript()}
    `,
  );
}

function selectedWorkspaceIds(body: Record<string, unknown>, allowed: Workspace[]) {
  const allowedIds = new Set(allowed.map((workspace) => workspace.id));
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(body)) {
    if (key.startsWith('workspace:') && value === '1') ids.add(key.slice('workspace:'.length));
  }
  for (const id of stringList(body.workspace_ids ?? body.workspace_id)) ids.add(id);
  const selected = Array.from(ids).filter((id) => allowedIds.has(id));
  if (ids.size !== selected.length) throw new Error('선택한 워크스페이스 중 접근할 수 없는 항목이 있습니다.');
  return selected;
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  const db = context.admin.db('app');
  const urls = endpointUrls(context);
  let params: ReturnType<typeof validateAuthorizeParams>;
  try {
    params = validateAuthorizeParams(paramsFromRequest(context.request), urls);
    const client = await resolveClient(db, params.clientId, params.redirectUri);
    if (!context.auth?.id) {
      return loginBridgePage(urls);
    }
    return renderConsent(params, client, await accessibleWorkspaces(db, context.auth.id), context.auth.email);
  } catch (error) {
    return htmlPage(
      'MCP OAuth 오류',
      `<h1>연결을 시작할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
      400,
    );
  }
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (!context.auth?.id) {
    return htmlPage('Hanji 로그인 필요', '<h1>로그인이 필요합니다</h1>', 401);
  }
  const db = context.admin.db('app');
  const urls = endpointUrls(context);
  const body = await requestBody(context.request);
  let params: ReturnType<typeof validateAuthorizeParams>;
  try {
    params = validateAuthorizeParams({
      ...body,
      response_type: 'code',
      scope: Object.keys(body)
        .filter((key) => key.startsWith('scope:') && body[key] === '1')
        .map((key) => key.slice('scope:'.length))
        .join(' '),
    }, urls);
    const client = await resolveClient(db, params.clientId, params.redirectUri);
    if (stringValue(body.decision) !== 'approve') {
      return oauthRedirect(context.request, body, params.redirectUri, {
        error: 'access_denied',
        error_description: 'The user denied Hanji MCP access.',
        state: params.state,
      });
    }

    const scopes = params.requestedScopes.length ? params.requestedScopes : MCP_DEFAULT_SCOPES;
    const allowedWorkspaces = await accessibleWorkspaces(db, context.auth.id);
    const workspaceAccess = stringValue(body.workspace_access, 'all_accessible') === 'selected'
      ? 'selected'
      : 'all_accessible';
    const workspaceIds = workspaceAccess === 'selected' ? selectedWorkspaceIds(body, allowedWorkspaces) : [];
    if (workspaceAccess === 'selected' && workspaceIds.length === 0) {
      throw new Error('특정 워크스페이스 연결에는 하나 이상의 워크스페이스 선택이 필요합니다.');
    }
    const now = nowIso();
    const grant = await db.table<McpOAuthGrant>('mcp_oauth_grants').insert({
      userId: context.auth.id,
      clientId: client.clientId,
      clientName: client.clientName ?? 'MCP client',
      resource: params.resource,
      scopes,
      workspaceAccess,
      workspaceIds,
      pageIds: [],
      databaseIds: [],
      readOnly: readOnlyFromScopes(scopes),
      status: 'active',
      lastUsedAt: now,
    });
    const code = randomToken('mcp_code');
    await db.table<McpOAuthAuthorizationCode>('mcp_oauth_authorization_codes').insert({
      codeHash: await sha256Base64Url(code),
      clientId: client.clientId,
      redirectUri: params.redirectUri,
      userId: context.auth.id,
      grantId: grant.id,
      resource: params.resource,
      scopes,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      expiresAt: authorizationCodeExpiresAt(),
      // Explicit null (not absent) so the token endpoint's atomic single-use
      // guard (`expect consumedAt == null`) matches an unredeemed code.
      consumedAt: null,
    });
    await bestEffort('mcp-oauth-authorize db.table(mcp_oauth_clients).up', db.table<McpOAuthClient>('mcp_oauth_clients').update(client.id, { lastUsedAt: now }));
    return oauthRedirect(context.request, body, params.redirectUri, {
      code,
      state: params.state,
    });
  } catch (error) {
    return htmlPage(
      'MCP OAuth 오류',
      `<h1>연결을 완료할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
      400,
    );
  }
});
