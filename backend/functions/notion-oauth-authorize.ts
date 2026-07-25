import { defineFunction } from '@edge-base/shared';
import {
  MCP_DEFAULT_SCOPES,
  type DbRef,
  type Workspace,
  accessibleWorkspaces,
  escapeHtml,
  htmlPage,
  json,
  listAll,
  redirectWithParams,
  requestBody,
  stringList,
  stringValue,
} from '../lib/mcp-oauth';
import {
  issueNotionCompatAuthorizationCode,
  resolveNotionCompatClientRegistration,
  signNotionCompatConsentRequest,
  validateNotionCompatRedirectUri,
  verifyNotionCompatConsentRequest,
} from '../lib/notion-compat-oauth';
import { pageAccessRole } from '../lib/page-access';
import {
  assertMcpClientApprovedForWorkspaces,
  filterMcpClientApprovedWorkspaces,
} from '../lib/enterprise-controls';

interface FunctionContext {
  request: Request;
  env?: Record<string, unknown>;
  auth: { id: string; email?: string | null } | null;
  admin: {
    db(namespace: string, instanceId?: string): DbRef;
  };
}

interface ConsentPage {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  kind?: string;
  title?: string;
  inTrash?: boolean;
  position?: number;
}

interface ConsentResource {
  id: string;
  workspaceId: string;
  kind: 'page' | 'database';
  title: string;
}

function paramsFromRequest(request: Request) {
  const url = new URL(request.url);
  return Object.fromEntries(url.searchParams.entries());
}

function hidden(name: string, value: unknown) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`;
}

function validateAuthorizeParams(input: Record<string, unknown>) {
  const responseType = stringValue(input.response_type);
  if (responseType !== 'code') throw new Error('response_type must be code.');
  const clientId = stringValue(input.client_id);
  if (!clientId) throw new Error('client_id is required.');
  const redirectUri = stringValue(input.redirect_uri);
  if (!redirectUri) throw new Error('redirect_uri is required.');
  const owner = stringValue(input.owner, 'user');
  if (owner !== 'user') throw new Error('Only owner=user is supported for Hanji integrations.');
  return {
    clientId,
    redirectUri,
    state: stringValue(input.state),
    preferredWorkspaceId: stringValue(input.workspace_id),
  };
}

function redirectTarget(redirectUri: string, params: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

function oauthRedirect(
  request: Request,
  body: Record<string, unknown>,
  redirectUri: string,
  params: Record<string, string | undefined>,
) {
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
    'files:read': '파일 읽기',
    'files:write': '파일 업로드 및 삭제',
    'workspace:read': '워크스페이스와 사용자 읽기',
  };
  return labels[scope] ?? scope;
}

async function consentResources(context: FunctionContext, workspaces: Workspace[]) {
  const resources: ConsentResource[] = [];
  for (const workspace of workspaces) {
    const db = context.admin.db('workspace', workspace.id);
    const pages = (await listAll(db.table<ConsentPage>('pages').where('workspaceId', '==', workspace.id)))
      .filter((page) => !page.inTrash && page.parentType !== 'database')
      .sort((left, right) => (left.position ?? 0) - (right.position ?? 0) || left.id.localeCompare(right.id));
    for (const page of pages) {
      if (resources.length >= 1_000) return resources;
      try {
        if (!(await pageAccessRole(db, page, context.auth!.id, undefined, context.auth?.email))) continue;
      } catch {
        continue;
      }
      resources.push({
        id: page.id,
        workspaceId: workspace.id,
        kind: page.kind === 'database' ? 'database' : 'page',
        title: page.title || 'Untitled',
      });
    }
  }
  return resources;
}

function consentBridgeScript() {
  return `<script>
(() => {
  const form = document.querySelector('form[data-notion-compat-consent]');
  if (!(form instanceof HTMLFormElement)) return;
  const status = document.querySelector('[data-notion-compat-status]');
  const setStatus = (message) => { if (status) status.textContent = message; };
  const syncResourceControls = () => {
    const workspace = form.querySelector('input[name="workspace_id"]:checked')?.value || '';
    const mode = form.querySelector('input[name="content_access"]:checked')?.value || 'all';
    for (const group of form.querySelectorAll('[data-resource-workspace]')) {
      const active = group.getAttribute('data-resource-workspace') === workspace;
      group.hidden = !active;
      for (const checkbox of group.querySelectorAll('input[name="resource_id"]')) {
        checkbox.disabled = !active || mode !== 'selected';
      }
    }
  };
  form.addEventListener('change', syncResourceControls);
  syncResourceControls();
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
      syncResourceControls();
      const selectedMode = form.querySelector('input[name="content_access"]:checked')?.value || 'all';
      if (selectedMode === 'selected' && !form.querySelector('input[name="resource_id"]:checked:not(:disabled)')) {
        throw new Error('선택한 페이지 접근을 사용하려면 페이지나 데이터베이스를 하나 이상 고르세요.');
      }
      const accessToken = await accessTokenFromBrowserSession();
      const body = new URLSearchParams(new FormData(form));
      const submitter = event.submitter;
      if (submitter instanceof HTMLButtonElement && submitter.name) body.set(submitter.name, submitter.value);
      body.set('bridge', '1');
      const response = await fetch(window.location.href, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + accessToken,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.redirect_to) throw new Error(result.error_description || result.error || '통합 연결을 완료할 수 없습니다.');
      window.location.assign(result.redirect_to);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  });
})();
</script>`;
}

function loginBridgePage() {
  return htmlPage(
    'Hanji 통합 연결 확인',
    `
      <h1>Hanji 세션 확인 중</h1>
      <p data-notion-compat-login-status>로그인 상태를 확인해서 통합 연결 승인 화면을 준비하고 있습니다.</p>
      <p><a href="/">Hanji 열기</a></p>
      <script>
      (async () => {
        const status = document.querySelector('[data-notion-compat-login-status]');
        const setStatus = (message) => { if (status) status.textContent = message; };
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
              'Authorization': 'Bearer ' + session.accessToken,
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

async function renderConsent(
  context: FunctionContext,
  client: { clientId: string; clientName: string },
  params: ReturnType<typeof validateAuthorizeParams>,
  workspaces: Workspace[],
  resources: ConsentResource[],
) {
  if (workspaces.length === 0) throw new Error('연결할 수 있는 활성 워크스페이스가 없습니다.');
  if (params.preferredWorkspaceId && !workspaces.some((workspace) => workspace.id === params.preferredWorkspaceId)) {
    throw new Error('요청한 workspace_id에 접근할 수 없습니다.');
  }
  const consent = await signNotionCompatConsentRequest(context, {
    userId: context.auth!.id,
    clientId: params.clientId,
    redirectUri: params.redirectUri,
    state: params.state,
    requestedScopes: MCP_DEFAULT_SCOPES,
  });
  const selectedId = params.preferredWorkspaceId || workspaces[0].id;
  const workspaceInputs = workspaces.map((workspace) => `
    <label>
      <input type="radio" name="workspace_id" value="${escapeHtml(workspace.id)}" ${workspace.id === selectedId ? 'checked' : ''} required />
      <span>${escapeHtml(workspace.name || workspace.domain || 'Untitled Workspace')}<br /><span class="muted">${escapeHtml(workspace.id)}</span></span>
    </label>`).join('');
  const capabilities = MCP_DEFAULT_SCOPES.map((scope) => `
    <li>${escapeHtml(scopeLabel(scope))} <span class="muted">(${escapeHtml(scope)})</span></li>`).join('');
  const resourceGroups = workspaces.map((workspace) => {
    const rows = resources.filter((resource) => resource.workspaceId === workspace.id);
    const inputs = rows.length
      ? rows.map((resource) => `
          <label>
            <input type="checkbox" name="resource_id" value="${escapeHtml(resource.id)}" />
            <span>${escapeHtml(resource.title)} <span class="muted">(${resource.kind === 'database' ? 'database' : 'page'})</span></span>
          </label>`).join('')
      : '<p class="muted">선택 가능한 페이지나 데이터베이스가 없습니다.</p>';
    return `<div data-resource-workspace="${escapeHtml(workspace.id)}" hidden>${inputs}</div>`;
  }).join('');
  return htmlPage(
    'Hanji 통합 연결 허용',
    `
      <h1>통합 연결 허용</h1>
      <p><strong>${escapeHtml(client.clientName)}</strong>에서 Hanji 워크스페이스에 접근하려고 합니다.</p>
      <p class="muted">로그인 계정: ${escapeHtml(context.auth?.email || '현재 Hanji 계정')}</p>
      <form method="post" data-notion-compat-consent>
        ${hidden('consent_request', consent)}
        <fieldset>
          <legend>연결할 워크스페이스</legend>
          ${workspaceInputs}
        </fieldset>
        <fieldset>
          <legend>통합 권한</legend>
          <ul>${capabilities}</ul>
          <p class="muted">이 권한은 이 승인 요청에 서명되어 있으며 브라우저에서 넓힐 수 없습니다.</p>
        </fieldset>
        <fieldset>
          <legend>접근할 콘텐츠</legend>
          <label>
            <input type="radio" name="content_access" value="all" checked />
            <span>이 워크스페이스의 모든 페이지</span>
          </label>
          <label>
            <input type="radio" name="content_access" value="selected" />
            <span>선택한 페이지와 그 하위 콘텐츠만</span>
          </label>
          ${resourceGroups}
          <p class="muted">선택한 데이터베이스에는 그 행이 포함되고, 선택한 페이지에는 하위 페이지가 포함됩니다.</p>
        </fieldset>
        <div class="actions">
          <button type="submit" name="decision" value="deny">거부</button>
          <button class="primary" type="submit" name="decision" value="approve">허용</button>
        </div>
        <p class="muted" data-notion-compat-status></p>
      </form>
      ${consentBridgeScript()}
    `,
  );
}

export const GET = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  try {
    const params = validateAuthorizeParams(paramsFromRequest(context.request));
    const db = context.admin.db('app');
    const client = await resolveNotionCompatClientRegistration(db, context.env, params.clientId);
    if (!client) throw new Error('Integration client is not registered.');
    validateNotionCompatRedirectUri(client, params.redirectUri);
    if (!context.auth?.id) return loginBridgePage();
    const workspaces = await filterMcpClientApprovedWorkspaces(
      db,
      await accessibleWorkspaces(db, context.auth.id),
      client.clientId,
    );
    return await renderConsent(
      context,
      client,
      params,
      workspaces,
      await consentResources(context, workspaces),
    );
  } catch (error) {
    return htmlPage(
      'Hanji 통합 OAuth 오류',
      `<h1>연결을 시작할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
      400,
    );
  }
});

export const POST = defineFunction(async (rawContext: unknown) => {
  const context = rawContext as FunctionContext;
  if (!context.auth?.id) return htmlPage('Hanji 로그인 필요', '<h1>로그인이 필요합니다</h1>', 401);
  const body = await requestBody(context.request);
  try {
    const consent = await verifyNotionCompatConsentRequest(
      context,
      stringValue(body.consent_request),
    );
    if (consent.sub !== context.auth.id) {
      throw new Error('Integration consent request belongs to a different Hanji account.');
    }
    const db = context.admin.db('app');
    const client = await resolveNotionCompatClientRegistration(db, context.env, consent.client_id);
    if (!client) throw new Error('Integration client is not registered.');
    validateNotionCompatRedirectUri(client, consent.redirect_uri);
    if (stringValue(body.decision) !== 'approve') {
      return oauthRedirect(context.request, body, consent.redirect_uri, {
        error: 'access_denied',
        error_description: 'The user denied Hanji integration access.',
        state: consent.state || undefined,
      });
    }
    const workspaceId = stringValue(body.workspace_id);
    if (!workspaceId) throw new Error('workspace_id is required.');
    const contentAccess = stringValue(body.content_access, 'all');
    if (contentAccess !== 'all' && contentAccess !== 'selected') {
      throw new Error('content_access must be all or selected.');
    }
    const resourceIds = contentAccess === 'selected' ? stringList(body.resource_id) : [];
    if (contentAccess === 'selected' && resourceIds.length === 0) {
      throw new Error('Select at least one accessible page or database.');
    }
    const workspace = (await accessibleWorkspaces(db, context.auth.id))
      .find((candidate) => candidate.id === workspaceId);
    if (!workspace) throw new Error('The selected workspace is not accessible.');
    await assertMcpClientApprovedForWorkspaces(db, [workspace], {
      actorId: context.auth.id,
      clientId: client.clientId,
      clientName: client.clientName,
      stage: 'authorization',
    });
    const issued = await issueNotionCompatAuthorizationCode(context, {
      userId: context.auth.id,
      clientId: consent.client_id,
      redirectUri: consent.redirect_uri,
      workspaceId,
      state: consent.state || undefined,
      scopes: consent.requested_scopes,
      resourceIds,
    });
    if (stringValue(body.bridge) === '1' || context.request.headers.get('Accept')?.includes('application/json')) {
      return json({ redirect_to: issued.redirectUrl });
    }
    return Response.redirect(issued.redirectUrl, 302);
  } catch (error) {
    return htmlPage(
      'Hanji 통합 OAuth 오류',
      `<h1>연결을 완료할 수 없습니다</h1><p>${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`,
      400,
    );
  }
});
