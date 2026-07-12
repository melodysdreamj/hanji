#!/usr/bin/env node

import { permanentlyDeletePage } from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let organizationId = '';
let workspaceId = '';
let pageId = '';
let legalHoldId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL enterprise controls smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Enterprise controls smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);
  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id ?? '';
  organizationId = bootstrap?.organization?.id ?? '';
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(organizationId, 'workspace-bootstrap must return an organization id');

  const suffix = crypto.randomUUID();
  const controls = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationEnterpriseControls',
    organizationId,
    ssoConfig: {
      enabled: true,
      providerType: 'saml',
      enforcement: 'required_for_verified_domains',
      loginUrl: 'https://idp.example.com/sso',
      entityId: 'urn:hanji:enterprise-smoke',
      certificateFingerprint: 'SHA256:enterprise-smoke',
      attributeMapping: { email: 'email', displayName: 'name' },
    },
    scimConfig: {
      enabled: true,
      provisioningMode: 'scim_v2',
      deprovisionAction: 'deactivate',
      requireVerifiedDomain: true,
    },
    auditPolicy: {
      retentionDays: 365,
      exportFormat: 'jsonl',
    },
    dataResidencyPolicy: {
      primaryRegion: 'kr',
      allowedRegions: ['kr'],
      enforcementMode: 'metadata_only',
      notes: 'Smoke-test metadata residency policy',
    },
    dlpPolicy: {
      enabled: true,
      blockPublicSharing: true,
      blockExternalSharing: true,
      blockFileDownloads: true,
      blockExports: true,
      sensitiveTerms: ['resident-registration-number'],
    },
    legalPolicy: {
      defaultHoldScope: 'organization',
      requireReason: true,
    },
    billingProfile: {
      planName: 'Enterprise smoke',
      contractStatus: 'active',
      billingEmail: `billing-${suffix}@example.com`,
      contractOwnerEmail: `owner-${suffix}@example.com`,
      renewalAt: '2027-01-01T00:00:00.000Z',
      poNumber: `PO-${suffix.slice(0, 8)}`,
    },
  });
  assert(controls?.enterpriseControls?.ssoConfig?.providerType === 'saml', 'SAML SSO config must persist');
  assert(controls.enterpriseControls?.scimConfig?.provisioningMode === 'scim_v2', 'SCIM config must persist');
  assert(controls.enterpriseControls?.auditPolicy?.retentionDays === 365, 'audit retention must persist');
  assert(controls.enterpriseControls?.dataResidencyPolicy?.primaryRegion === 'kr', 'data residency policy must persist');
  assert(controls.enterpriseControls?.dlpPolicy?.blockExports === true, 'DLP export block must persist');
  assert(controls.enterpriseControls?.billingProfile?.contractStatus === 'active', 'billing profile must persist');
  console.log('PASS enterprise controls persist SSO, SCIM, audit, residency, DLP, legal, and billing policies.');

  const scimCreated = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'createOrganizationScimToken',
    organizationId,
    label: 'Enterprise smoke SCIM',
  });
  const scimTokenId = scimCreated?.scimToken?.id;
  assert(scimTokenId, 'SCIM token creation must return a token id');
  assert(
    typeof scimCreated.scimTokenSecret === 'string' &&
      scimCreated.scimTokenSecret.startsWith('scim_'),
    'SCIM token creation must return a one-time secret',
  );
  assert(!('tokenHash' in scimCreated.scimToken), 'SCIM token responses must not expose tokenHash');
  const scimRevoked = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'revokeOrganizationScimToken',
    organizationId,
    scimTokenId,
  });
  assert(
    scimRevoked?.organizationScimTokens?.some(
      (token) => token.id === scimTokenId && token.status === 'revoked',
    ),
    'SCIM token revoke must mark the token revoked',
  );
  console.log('PASS SCIM token lifecycle stores only redacted token metadata after creation.');

  const billing = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'upsertOrganizationBillingRecord',
    organizationId,
    kind: 'contract',
    status: 'active',
    title: `Enterprise contract ${suffix}`,
    amountCents: 2500000,
    currency: 'USD',
    billingEmail: `billing-record-${suffix}@example.com`,
    contractOwnerEmail: `owner-record-${suffix}@example.com`,
    renewalAt: '2027-02-01T00:00:00.000Z',
  });
  assert(
    billing?.organizationBillingRecords?.some((record) => record.title === `Enterprise contract ${suffix}`),
    'billing admin record must persist in organization directory',
  );
  console.log('PASS contract/billing records can be administered by organization billing authority.');

  const auditExport = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'exportOrganizationAuditEvents',
    organizationId,
    auditAction: 'organization_enterprise_controls.update',
    auditLimit: 10,
    format: 'jsonl',
  });
  assert(auditExport?.auditExport?.eventCount >= 1, 'audit export must include matching events');
  assert(
    typeof auditExport.auditExportContent === 'string' &&
      auditExport.auditExportContent.includes('organization_enterprise_controls.update'),
    'audit export content must include matching events',
  );
  console.log('PASS audit export records filtered export jobs and returns export content.');

  const page = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Enterprise controls smoke ${suffix}`,
    position: Date.now(),
  });
  pageId = page?.page?.id ?? '';
  assert(pageId, 'page fixture must be created');

  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: true,
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    principalId: `external-${suffix}@example.com`,
    label: `external-${suffix}@example.com`,
    role: 'view',
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'import-export', {
    action: 'exportPageMarkdown',
    pageId,
  }, 423);
  console.log('PASS DLP policy blocks public sharing, external email sharing, and exports.');

  const legalHold = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'createOrganizationLegalHold',
    organizationId,
    name: `Enterprise legal hold ${suffix}`,
    reason: 'Enterprise controls smoke',
    scope: { pageIds: [pageId] },
  });
  const activeHold = legalHold?.organizationLegalHolds?.find((hold) => hold.name === `Enterprise legal hold ${suffix}`);
  legalHoldId = activeHold?.id ?? '';
  assert(legalHoldId, 'legal hold creation must return the active hold');
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'trash',
    id: pageId,
  });
  // Intentional raw delete: the root is explicitly trashed above so this call
  // isolates the legal-hold rejection instead of the active-page guard.
  await expectFunctionStatus(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: pageId,
  }, 400);
  const released = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'releaseOrganizationLegalHold',
    organizationId,
    legalHoldId,
  });
  assert(
    released?.organizationLegalHolds?.some((hold) => hold.id === legalHoldId && hold.status === 'released'),
    'legal hold release must mark the hold released',
  );
  legalHoldId = '';
  // Intentional raw delete: the same root remains in trash after the denied
  // attempt, and this verifies that releasing the hold alone unblocks it.
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: pageId,
  });
  pageId = '';
  console.log('PASS active legal holds block permanent deletion until released.');

  console.log('\nPASS enterprise controls work through product APIs.');
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);
  if (organizationId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'updateOrganizationEnterpriseControls',
      organizationId,
      dlpPolicy: {
        enabled: false,
        blockPublicSharing: false,
        blockExternalSharing: false,
        blockFileDownloads: false,
        blockExports: false,
        sensitiveTerms: [],
      },
    }).catch(() => {});
    if (legalHoldId) {
      await callFunction(baseUrl, owner.token, 'workspace-mutation', {
        action: 'releaseOrganizationLegalHold',
        organizationId,
        legalHoldId,
      }).catch(() => {});
      legalHoldId = '';
    }
  }
  if (pageId) {
    await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction }).catch(() => {});
    pageId = '';
  }
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/enterprise-controls-smoke.mjs [options]

Checks enterprise organization controls, SCIM token lifecycle, audit export,
DLP enforcement, legal hold delete blocking, and billing record administration
against a running Hanji EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function expectFunctionStatus(baseUrl, token, name, body, status) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(`${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function postFunction(baseUrl, token, name, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
