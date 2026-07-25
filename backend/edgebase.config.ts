import { defineConfig } from '@edge-base/shared';
import { rateLimiting } from './config/rate-limits';
import {
  WORKSPACE_CONTENT_TABLES,
} from './lib/workspace-db';
import { pageAccessRole } from './lib/page-access';
import {
  LEGACY_REFRESH_COOKIE_BASE_NAME_DELETE_ONLY,
  hanjiEnvFlag,
  hanjiEnvList,
  hanjiEnvListWithOffSentinel,
  hanjiEnvValue,
} from './lib/hanji-compat';

const PAGE_ROOM_ID_RE = /^[a-zA-Z0-9._:-]{1,160}$/;
const ROOM_CONTENT_TABLE_NAMES = new Set<string>(WORKSPACE_CONTENT_TABLES);

function envValue(...names: string[]) {
  return hanjiEnvValue(undefined, ...names);
}

function envList(...names: string[]) {
  return hanjiEnvList(undefined, ...names);
}

function envListWithOffSentinel(...names: string[]) {
  return hanjiEnvListWithOffSentinel(undefined, ...names);
}

function envFlag(name: string) {
  return hanjiEnvFlag(undefined, name);
}

function originHostname(origin: string) {
  try {
    return new URL(origin).hostname;
  } catch {
    return 'localhost';
  }
}

function oauthEnvName(provider: string, field: 'CLIENT_ID' | 'CLIENT_SECRET') {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + `_${field}`;
}

function oauthEnvPrefix(provider: string) {
  return provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

const APP_ORIGIN =
  envValue('HANJI_APP_ORIGIN', 'EDGEBASE_APP_ORIGIN') ??
  'http://localhost:8787';
const AUTH_ORIGIN =
  envValue('HANJI_AUTH_ORIGIN') ??
  APP_ORIGIN;

export function authEmailActionUrls(appOrigin: string) {
  const origin = appOrigin.replace(/\/+$/, '');
  return {
    verifyUrl: `${origin}/auth/verify-email#token={token}`,
    resetUrl: `${origin}/auth/reset-password#token={token}`,
    emailChangeUrl: `${origin}/auth/verify-email-change#token={token}`,
  };
}
const PASSKEY_RP_ID =
  envValue('HANJI_PASSKEY_RP_ID', 'EDGEBASE_PASSKEY_RP_ID') ??
  originHostname(AUTH_ORIGIN);
const PASSKEY_ORIGINS = envList('HANJI_PASSKEY_ORIGINS', 'EDGEBASE_PASSKEY_ORIGINS');
const AUTH_EMAIL_FROM =
  envValue('HANJI_AUTH_EMAIL_FROM', 'EDGEBASE_EMAIL_FROM') ??
  'noreply@localhost';
const CLOUDFLARE_EMAIL_API_TOKEN =
  envValue(
    'HANJI_CLOUDFLARE_EMAIL_API_TOKEN',
    'EDGEBASE_EMAIL_CLOUDFLARE_API_TOKEN',
    'EDGEBASE_EMAIL_API_KEY',
  );
const CLOUDFLARE_EMAIL_ACCOUNT_ID =
  envValue('HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID', 'EDGEBASE_EMAIL_CLOUDFLARE_ACCOUNT_ID');
const CLOUDFLARE_EMAIL_BINDING =
  envValue('HANJI_CLOUDFLARE_EMAIL_BINDING', 'EDGEBASE_EMAIL_CLOUDFLARE_BINDING') ??
  'EMAIL';
const OAUTH_PROVIDER_NAMES = envListWithOffSentinel(
  'HANJI_AUTH_OAUTH_PROVIDERS',
  'EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS',
);
const BUILTIN_OAUTH_PROVIDERS = Object.fromEntries(
  OAUTH_PROVIDER_NAMES.filter((provider) => !provider.startsWith('oidc:')).map((provider) => {
    const envKey = oauthEnvName(provider, 'CLIENT_ID');
    const secretKey = oauthEnvName(provider, 'CLIENT_SECRET');
    const clientId =
      envValue(`HANJI_OAUTH_${envKey}`, `EDGEBASE_OAUTH_${envKey}`, envKey);
    const clientSecret =
      envValue(`HANJI_OAUTH_${secretKey}`, `EDGEBASE_OAUTH_${secretKey}`, secretKey);
    if (!clientId || !clientSecret) return null;
    return [provider, { clientId, clientSecret }] as const;
  }).filter((entry): entry is readonly [string, { clientId: string; clientSecret: string }] => !!entry),
);
const OIDC_OAUTH_PROVIDERS = Object.fromEntries(
  OAUTH_PROVIDER_NAMES.filter((provider) => /^oidc:[A-Za-z0-9._-]+$/.test(provider)).map((provider) => {
    const name = provider.slice('oidc:'.length);
    const envPrefix = oauthEnvPrefix(provider);
    const clientId = envValue(
      `HANJI_OAUTH_${envPrefix}_CLIENT_ID`,
      `EDGEBASE_OAUTH_${envPrefix}_CLIENT_ID`,
      `${envPrefix}_CLIENT_ID`,
    );
    const clientSecret = envValue(
      `HANJI_OAUTH_${envPrefix}_CLIENT_SECRET`,
      `EDGEBASE_OAUTH_${envPrefix}_CLIENT_SECRET`,
      `${envPrefix}_CLIENT_SECRET`,
    );
    const issuer = envValue(
      `HANJI_OAUTH_${envPrefix}_ISSUER`,
      `EDGEBASE_OAUTH_${envPrefix}_ISSUER`,
      `${envPrefix}_ISSUER`,
    );
    if (!clientId || !clientSecret || !issuer) return null;
    const scopes = envList(
      `HANJI_OAUTH_${envPrefix}_SCOPES`,
      `EDGEBASE_OAUTH_${envPrefix}_SCOPES`,
      `${envPrefix}_SCOPES`,
    );
    return [name, {
      clientId,
      clientSecret,
      issuer,
      ...(scopes.length ? { scopes } : {}),
    }] as const;
  }).filter((entry): entry is readonly [string, {
    clientId: string;
    clientSecret: string;
    issuer: string;
    scopes?: string[];
  }] => !!entry),
);
const OAUTH_PROVIDERS = {
  ...BUILTIN_OAUTH_PROVIDERS,
  ...(Object.keys(OIDC_OAUTH_PROVIDERS).length ? { oidc: OIDC_OAUTH_PROVIDERS } : {}),
};
const ALLOWED_OAUTH_PROVIDERS = [
  ...Object.keys(BUILTIN_OAUTH_PROVIDERS),
  ...Object.keys(OIDC_OAUTH_PROVIDERS).map((name) => `oidc:${name}`),
];
const ALLOW_DEV_GUEST_LOGIN = envFlag('HANJI_ALLOW_DEV_GUEST_LOGIN');
const TRUST_SELF_HOSTED_PROXY = envFlag('HANJI_TRUST_SELF_HOSTED_PROXY');
const ALLOW_INSECURE_LOCALHOST_AUTH = ALLOW_DEV_GUEST_LOGIN || TRUST_SELF_HOSTED_PROXY;

interface Workspace {
  id: string;
  ownerId?: string;
  organizationId?: string | null;
}

interface Page {
  id: string;
  workspaceId: string;
  parentId?: string | null;
  parentType?: string;
  inTrash?: boolean;
  createdBy?: string;
}

interface ListResult<T> {
  items?: T[];
  hasMore?: boolean;
}

interface TableRef<T> {
  getOne(id: string): Promise<T | null>;
  where(field: string, op: string, value: unknown): TableQuery<T>;
}

interface TableQuery<T> {
  page(n: number): TableQuery<T>;
  limit(n: number): TableQuery<T>;
  getList(): Promise<ListResult<T>>;
}

interface RoomAccessContext {
  admin: {
    db(namespace: string, instanceId?: string): {
      table<T>(name: string): TableRef<T>;
    };
  };
}


function authId(auth: unknown) {
  if (!auth || typeof auth !== 'object') return '';
  const id = (auth as { id?: unknown }).id;
  return typeof id === 'string' ? id : '';
}

function normalizeAccessEmail(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function authEmail(auth: unknown) {
  if (!auth || typeof auth !== 'object') return '';
  return normalizeAccessEmail((auth as { email?: unknown }).email);
}

function roomAccessDebugEnabled() {
  return envValue('HANJI_DEBUG_ROOM_ACCESS') === '1';
}

const ENTERPRISE_CONTROLS_DEDUPLICATE_SQL = `
  DELETE FROM "organization_enterprise_controls"
  WHERE "id" IN (
    SELECT "id"
    FROM (
      SELECT
        "id",
        ROW_NUMBER() OVER (
          PARTITION BY "organizationId"
          ORDER BY
            COALESCE("updatedAt", "createdAt") DESC NULLS LAST,
            "createdAt" DESC NULLS LAST,
            "id" DESC
        ) AS "duplicateRank"
      FROM "organization_enterprise_controls"
    ) AS "rankedEnterpriseControls"
    WHERE "duplicateRank" > 1
  );
`;

function denyPagePresence(reason: string, details: Record<string, unknown>) {
  if (roomAccessDebugEnabled()) {
    throw new Error(`page-presence denied: ${reason} ${JSON.stringify(details)}`);
  }
  return false;
}

async function getExisting<T>(
  tableRef: TableRef<T>,
  id: string,
  label = 'record',
): Promise<T | null> {
  try {
    return await tableRef.getOne(id);
  } catch (error) {
    if (roomAccessDebugEnabled()) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`page-presence lookup failed: ${label}:${id} ${message}`);
    }
    return null;
  }
}

export async function canUsePagePresenceRoom(
  auth: unknown,
  roomId: string,
  ctx?: unknown,
) {
  // EdgeBase's room config type currently exposes a narrower RoomDbProxy than
  // the runtime admin DB facade used by access hooks. Keep the assertion at
  // this single boundary so the permission walk below remains fully typed and
  // the config can be checked by tsc.
  const roomContext = ctx as RoomAccessContext | undefined;
  const userId = authId(auth);
  const email = authEmail(auth);
  if (!userId || !PAGE_ROOM_ID_RE.test(roomId) || !roomContext?.admin?.db) {
    return denyPagePresence('invalid-request', {
      hasDb: !!roomContext?.admin?.db,
      hasUserId: !!userId,
      roomId,
      roomIdValid: PAGE_ROOM_ID_RE.test(roomId),
    });
  }

  const centralDb = roomContext.admin.db('app');
  const routingRow = await getExisting(
    centralDb.table<{ id: string; workspaceId: string }>('page_workspace_index'),
    roomId,
    'page_workspace_index',
  );
  const roomWorkspaceId = routingRow?.workspaceId;
  if (!roomWorkspaceId) {
    return denyPagePresence('page-not-found', { roomId, userId });
  }
  const contentDb = roomContext.admin.db('workspace', roomWorkspaceId);
  // Room hooks receive the raw admin DB facade, while product functions use a
  // routed facade that sends content tables to the per-workspace block and
  // account/membership tables to the central app block. Recreate that routing
  // here so the access walk cannot look for `workspaces` in the content-only
  // block and deny every otherwise valid room join.
  const db = {
    table<T>(name: string) {
      return (ROOM_CONTENT_TABLE_NAMES.has(name) ? contentDb : centralDb).table<T>(name);
    },
  };
  const rootPage = await getExisting(db.table<Page>('pages'), roomId, 'pages');
  if (!rootPage || rootPage.inTrash) {
    return denyPagePresence(rootPage?.inTrash ? 'page-in-trash' : 'page-not-found', { roomId, userId });
  }

  const workspace = await getExisting(db.table<Workspace>('workspaces'), rootPage.workspaceId, 'workspaces');
  if (!workspace) {
    return denyPagePresence('workspace-not-found', {
      pageId: rootPage.id,
      userId,
      workspaceId: rootPage.workspaceId,
    });
  }

  // Presence mirrors the mutation-path access walk exactly (owner/creator
  // shortcuts, workspace membership, group + email principals, ancestor
  // inheritance). pageAccessRole throws for deactivated organization members,
  // which must deny presence rather than error the room upgrade.
  let role: string | undefined;
  try {
    role = await pageAccessRole(db, rootPage, userId, workspace, email);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return denyPagePresence('access-walk-rejected', {
      message,
      pageId: rootPage.id,
      userId,
      workspaceId: workspace.id,
    });
  }
  if (role) return true;

  return denyPagePresence('no-matching-permission', {
    pageCreatedBy: rootPage.createdBy ?? null,
    pageId: rootPage.id,
    userId,
    workspaceId: workspace.id,
    workspaceOwnerId: workspace.ownerId ?? null,
  });
}

/**
 * Hanji — local backend data model.
 *
 * Core model (mirrors Notion's own structure):
 *   organizations ─┬─ workspaces ─┬─ pages (tree; a page is either a document or a database container)
 *                  │              │     ├─ blocks         (a page's body content; blocks can nest)
 *                  │              │     ├─ db_properties  (columns, when the page is a database)
 *                  │              │     └─ db_views       (saved views, when the page is a database)
 *                  │              │     └─ db_templates   (row/page templates, when the page is a database)
 *                  │              ├─ notion_import_jobs / items / mappings
 *                  │              ├─ comments
 *                  │              ├─ page_permissions
 *                  │              └─ share_links
 *                  ├─ organization_members
 *                  ├─ organization_groups
 *                  ├─ organization_group_members
 *                  ├─ organization_domains
 *                  ├─ organization_enterprise_controls
 *                  ├─ organization_scim_tokens
 *                  ├─ organization_legal_holds
 *                  ├─ organization_audit_exports
 *                  ├─ organization_billing_records
 *                  └─ organization_audit_events
 *
 * A database ROW is itself a page (`parentType: 'database'`) whose column values
 * live in `pages.properties` (json). This is exactly how Notion treats rows as pages.
 *
 * `id`, `createdAt`, `updatedAt` are injected automatically by EdgeBase.
 * Enum-ish fields (block `type`, property `type`, view `type`, …) are kept as plain
 * strings (validated in the app layer) so new variants can be added without migrations.
 */
// All `app`-block table definitions. Extracted to a named constant so the
// dynamic per-workspace block below can derive its content tables from the
// same source of truth (docs/workspace-do-migration.md).
const appTables = {
        // ─── Organizations / accounts ─────────────────────────────────
        organizations: {
          schema: {
            name: { type: 'string', required: true },
            icon: { type: 'string' },
            ownerId: { type: 'string' },
            workspaceCreationPolicy: { type: 'string', default: 'owners_admins' },
            domainSignupPolicy: { type: 'string', default: 'invite_only' },
            sharingPolicy: { type: 'json' },
            storageLimitBytes: { type: 'number' },
            // Cross-table governance writers increment this row so a
            // PostgreSQL transaction takes a real write fence, rather than a
            // lock-only snapshot that can miss a concurrent policy/hold write.
            governanceVersion: { type: 'number', required: true, default: 0 },
            // Monotonic SSO authorization fence. Required SSO becomes
            // effective only after every pre-transition member session has
            // been revoked and stamped for the next epoch.
            ssoEnforcementEpoch: { type: 'number', required: true, default: 0 },
          },
          indexes: [
            { fields: ['ownerId'] },
            { fields: ['createdAt', 'id'] },
          ],
        },

        // Central, organization-wide storage accounting. File rows live in
        // per-workspace DOs, so a check-then-insert against those shards cannot
        // enforce a shared quota under concurrency. Every manual/import upload
        // reserves here first through a versioned transaction; the per-upload
        // row makes settlement idempotent.
        organization_storage_usage: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            reservedBytes: { type: 'number', required: true, default: 0 },
            version: { type: 'number', required: true, default: 0 },
            reconciledAt: { type: 'datetime' },
          },
          indexes: [{ fields: ['organizationId'] }],
        },

        organization_storage_reservations: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            workspaceId: { type: 'string', required: true },
            bytes: { type: 'number', required: true },
            status: { type: 'string', required: true, default: 'active' },
            releasedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['workspaceId'] },
            { fields: ['status'] },
          ],
        },

        // Central page → workspace routing index (docs/workspace-do-migration.md):
        // /p/:pageId entry points resolve the owning workspace here after the
        // split. Maintained by the pages insert/delete DB trigger
        // (functions/on-page-index.ts); backfilled by the migration script.
        page_workspace_index: {
          schema: {
            workspaceId: { type: 'string', required: true },
          },
          indexes: [{ fields: ['workspaceId'] }],
        },

        // Central page-permission routing index (docs/workspace-do-migration.md):
        // discovery rows only — "which workspaces hold grants for this
        // principal" (bootstrap shared-workspace fallback) and "which
        // workspace owns this permissionId" (permissionId-only mutation
        // entries). Authoritative permission checks stay on the
        // workspace-block page_permissions rows; a stale index row cannot
        // grant access. Maintained by functions/on-page-permission-index.ts.
        page_permission_index: {
          schema: {
            workspaceId: { type: 'string', required: true },
            pageId: { type: 'string', required: true },
            principalType: { type: 'string', required: true },
            principalId: { type: 'string' },
          },
          indexes: [
            { fields: ['principalId'] },
            { fields: ['workspaceId'] },
          ],
        },

        // Central share-token routing index (docs/workspace-do-migration.md):
        // unauthenticated /share/<token> requests resolve the owning
        // workspace here after the split; the authoritative enabled checks
        // still run on the workspace-block share_links row (fail-closed).
        share_link_index: {
          schema: {
            token: { type: 'string', required: true, unique: true },
            workspaceId: { type: 'string', required: true },
            pageId: { type: 'string', required: true },
            enabled: { type: 'boolean', default: false },
          },
          indexes: [{ fields: ['token'] }, { fields: ['workspaceId'] }],
        },

        // Minimal unavoidable public-site router. The central block contains
        // only exact slug/Host discovery metadata; site configuration and all
        // content remain authoritative in the owning workspace block.
        site_route_index: {
          schema: {
            routeKey: { type: 'string', required: true, unique: true },
            routeKind: { type: 'string', required: true },
            routeValue: { type: 'string', required: true },
            workspaceId: { type: 'string', required: true },
            siteId: { type: 'string', required: true },
            pageId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            revision: { type: 'number', required: true },
          },
          indexes: [
            { fields: ['routeKey'], unique: true },
            { fields: ['workspaceId'] },
            { fields: ['siteId'] },
            { fields: ['status'] },
          ],
        },

        // Routing-only form capability index. The workspace form_links row,
        // exact form view and database remain authoritative.
        form_link_index: {
          schema: {
            token: { type: 'string', required: true, unique: true },
            workspaceId: { type: 'string', required: true },
            databaseId: { type: 'string', required: true },
            viewId: { type: 'string', required: true },
            enabled: { type: 'boolean', default: false },
          },
          indexes: [{ fields: ['token'] }, { fields: ['workspaceId'] }],
        },

        // Central policy-cache invalidation stamp (docs/workspace-do-migration.md):
        // bumped by every org policy / member-status / legal-hold mutation so
        // workspace DOs can validate their cached policy snapshot with one
        // tiny point read after the split.
        organization_policy_versions: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            version: { type: 'number', required: true, default: 1 },
          },
          indexes: [{ fields: ['organizationId'] }],
        },

        instance_settings: {
          schema: {
            signupPolicy: { type: 'string', default: 'public' },
            memberAddPolicy: { type: 'string' },
            instanceAdminUserIds: { type: 'json' },
            // Collision-proof, bounded authority invalidation token. Every
            // settings upsert replaces it; foreground workspace probes project
            // this scalar instead of materializing the unbounded admin-id JSON.
            authorityVersion: { type: 'string' },
            masterUserId: { type: 'string' },
            masterEmail: { type: 'string' },
            updatedBy: { type: 'string' },
          },
        },

        // Product readiness proves a real application-database commit with one
        // atomic expect/insert/delete transaction. The row never survives the
        // transaction; a dedicated table keeps the probe out of product data.
        health_write_probes: {
          schema: {
            probeToken: { type: 'string', required: true },
          },
        },

        // One-time first-run web setup claim. The fixed `global` row closes
        // concurrent installer races before the auth account is created.
        instance_setup: {
          schema: {
            state: { type: 'string', required: true },
            email: { type: 'string', required: true },
            userId: { type: 'string' },
            claimedAt: { type: 'datetime', required: true },
            completedAt: { type: 'datetime' },
          },
          indexes: [{ fields: ['state'] }, { fields: ['email'] }],
        },

        // Per-account product flags keyed by auth user id (row id = userId).
        // mustChangePassword marks admin-issued temporary credentials; the
        // language fields keep a user's explicit UI preference across devices.
        account_flags: {
          schema: {
            mustChangePassword: { type: 'boolean', default: false },
            reason: { type: 'string' },
            updatedBy: { type: 'string' },
            languagePreference: { type: 'string' },
            languageOnboardingCompleted: { type: 'boolean', default: false },
            languageUpdatedAt: { type: 'datetime' },
          },
        },

        // Workspace-scoped, server-durable product onboarding. The row id is
        // the workspace id so a claim can atomically insert-if-absent across
        // tabs and devices. Existing/populated workspaces never need a row.
        workspace_onboarding: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            notionImportState: { type: 'string', default: 'presented' },
            notionImportPresentedAt: { type: 'datetime' },
            notionImportPresentedBy: { type: 'string' },
            notionImportSuppressedAt: { type: 'datetime' },
            notionImportSuppressedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['notionImportState'] },
          ],
        },

        instance_audit_events: {
          schema: {
            actorId: { type: 'string' },
            action: { type: 'string', required: true },
            targetType: { type: 'string' },
            targetId: { type: 'string' },
            targetLabel: { type: 'string' },
            metadata: { type: 'json' },
            occurredAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['actorId'] },
            { fields: ['action'] },
            { fields: ['targetType'] },
            { fields: ['targetId'] },
            { fields: ['occurredAt'] },
          ],
        },

        organization_members: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            displayName: { type: 'string' },
            email: { type: 'string' },
            avatar: { type: 'string' },
            role: { type: 'string', default: 'member' }, // owner | admin | member | guest
            status: { type: 'string', default: 'active' }, // active | deactivated
            externalId: { type: 'string' },
            provisionedBy: { type: 'string' },
            createdBy: { type: 'string' },
            deactivatedAt: { type: 'datetime' },
            deactivatedBy: { type: 'string' },
            ssoEnforcementEpoch: { type: 'number', default: 0 },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['userId'] },
            { fields: ['status'] },
            { fields: ['organizationId', 'userId'] },
            { fields: ['organizationId', 'status'] },
          ],
        },

        organization_groups: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            name: { type: 'string', required: true },
            description: { type: 'text' },
            externalId: { type: 'string' },
            provisionedBy: { type: 'string' },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['name'] },
          ],
        },

        organization_group_members: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            groupId: {
              type: 'string',
              required: true,
              references: { table: 'organization_groups', onDelete: 'CASCADE' },
            },
            organizationMemberId: {
              type: 'string',
              required: true,
              references: { table: 'organization_members', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            role: { type: 'string', default: 'member' },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['groupId'] },
            { fields: ['organizationMemberId'] },
            { fields: ['userId'] },
            { fields: ['organizationId', 'userId'] },
            { fields: ['organizationId', 'userId', 'id'] },
            { fields: ['organizationId', 'organizationMemberId'] },
            { fields: ['organizationId', 'organizationMemberId', 'userId', 'id'] },
            { fields: ['organizationMemberId', 'groupId'], unique: true },
          ],
        },

        organization_domains: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            domain: { type: 'string', required: true },
            status: { type: 'string', default: 'pending' }, // pending | verified | rejected
            verificationMethod: { type: 'string', default: 'dns_txt' },
            verificationToken: { type: 'string' },
            verificationCheckedAt: { type: 'datetime' },
            verificationError: { type: 'string' },
            createdBy: { type: 'string' },
            verifiedAt: { type: 'datetime' },
            verifiedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['domain'] },
            { fields: ['status'] },
          ],
        },

        organization_audit_events: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            workspaceId: { type: 'string' },
            actorId: { type: 'string' },
            action: { type: 'string', required: true },
            targetType: { type: 'string' },
            targetId: { type: 'string' },
            metadata: { type: 'json' },
            occurredAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['organizationId', 'occurredAt', 'id'] },
            { fields: ['workspaceId'] },
            { fields: ['actorId'] },
            { fields: ['action'] },
            { fields: ['occurredAt'] },
          ],
        },

        enterprise_maintenance_state: {
          schema: {
            kind: { type: 'string', required: true, unique: true },
            cursorOrganizationId: { type: 'string' },
            cursorOrganizationCreatedAt: { type: 'datetime' },
            version: { type: 'number', default: 0 },
            leaseToken: { type: 'string' },
            leaseExpiresAt: { type: 'datetime' },
            lastCompletedAt: { type: 'datetime' },
            nextDueAt: { type: 'datetime' },
            sweepId: { type: 'string' },
            sweepStartedAt: { type: 'datetime' },
            sweepUpperCreatedAt: { type: 'datetime' },
            discoveryComplete: { type: 'boolean', default: false },
            discoveryFailureCount: { type: 'number', default: 0 },
            discoveryNextAttemptAt: { type: 'datetime' },
            discoveryLastFailure: { type: 'text' },
            discoveryLastFailureAt: { type: 'datetime' },
            selectionFailureCount: { type: 'number', default: 0 },
            selectionNextAttemptAt: { type: 'datetime' },
            selectionLastFailure: { type: 'text' },
            selectionLastFailureAt: { type: 'datetime' },
            pendingWorkCount: { type: 'number', default: 0 },
            failedWorkCount: { type: 'number', default: 0 },
            lastFailedWorkCount: { type: 'number', default: 0 },
            currentDeliveryId: { type: 'string' },
            currentDeliveryScheduledAt: { type: 'datetime' },
            currentDeliveryAttempted: { type: 'number', default: 0 },
            currentDeliveryRetryAttempted: { type: 'number', default: 0 },
            currentDeliveryBacklogAttempted: { type: 'number', default: 0 },
            currentDeliveryReadyAttempted: { type: 'number', default: 0 },
            currentDeliverySettled: { type: 'boolean', default: false },
            // Durable keyset for bounded retention-work orphan reclamation.
            // It stays separate from daily organization discovery because
            // terminal and historical work rows remain eligible.
            orphanWorkCursorOrganizationId: { type: 'string' },
            migrationCursorCreatedAt: { type: 'datetime' },
            migrationCursorId: { type: 'string' },
            migrationComplete: { type: 'boolean', default: false },
            migrationConflictCount: { type: 'number', default: 0 },
            migrationPassConflictCount: { type: 'number', default: 0 },
            migrationLastConflict: { type: 'text' },
            migrationLastConflictAt: { type: 'datetime' },
            migrationScheduleIdentity: { type: 'string' },
            migrationLimitProfile: { type: 'string' },
          },
          indexes: [
            { fields: ['kind'] },
            { fields: ['leaseExpiresAt'] },
            { fields: ['currentDeliveryScheduledAt'] },
          ],
        },

        // One bounded, reusable row per organization. Campaign discovery
        // resets these rows in bulk; backlog and retry lanes update them
        // independently so a heavy or malformed tenant never waits for a full
        // organization rescan and never blocks healthy work.
        enterprise_retention_work: {
          schema: {
            organizationId: { type: 'string', required: true, unique: true },
            organizationCreatedAt: { type: 'datetime', required: true },
            sweepId: { type: 'string', required: true },
            status: { type: 'string', required: true },
            version: { type: 'number', required: true, default: 0 },
            nextAttemptAt: { type: 'datetime', required: true },
            failureCount: { type: 'number', required: true, default: 0 },
            lastFailure: { type: 'text' },
            lastFailureAt: { type: 'datetime' },
            lastDeliveryId: { type: 'string' },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['sweepId', 'status', 'nextAttemptAt', 'organizationId'] },
            { fields: ['status', 'nextAttemptAt'] },
          ],
        },

        organization_enterprise_controls: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            ssoConfig: { type: 'json' },
            scimConfig: { type: 'json' },
            auditPolicy: { type: 'json' },
            // Retention reads only these bounded scalars; it never fetches the
            // potentially large auditPolicy document into a maintenance slice.
            auditRetentionDays: { type: 'number' },
            auditRetentionPolicyValid: { type: 'boolean' },
            auditRetentionPolicyError: { type: 'string' },
            dataResidencyPolicy: { type: 'json' },
            dlpPolicy: { type: 'json' },
            legalPolicy: { type: 'json' },
            billingProfile: { type: 'json' },
            mcpGovernancePolicy: { type: 'json' },
            version: { type: 'number', default: 0 },
            updatedBy: { type: 'string' },
          },
          // Historical versions created this row with read-then-insert and no
          // physical uniqueness. EdgeBase runs this provider-native data
          // repair after additive columns but before final UNIQUE reconcile.
          migrations: [{
            version: 2,
            description: 'Keep the newest enterprise-controls row per organization',
            up: ENTERPRISE_CONTROLS_DEDUPLICATE_SQL,
            upPg: ENTERPRISE_CONTROLS_DEDUPLICATE_SQL,
          }],
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['updatedBy'] },
          ],
        },

        // Required-SSO activation is a durable state machine because the
        // external auth provider cannot participate in the controls
        // transaction. One row per deterministic request owns a bounded,
        // restart-safe membership rescan and becomes active atomically with
        // the controls/policy versions.
        organization_sso_transitions: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            pendingOrganizationId: { type: 'string', unique: true },
            actorId: { type: 'string', required: true },
            controlsId: { type: 'string', required: true },
            controlsVersion: { type: 'number', required: true },
            controlsVersionWasMissing: { type: 'boolean', required: true, default: false },
            requestHash: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            desiredPatch: { type: 'json', required: true },
            desiredMetadata: { type: 'json', required: true },
            previousEpoch: { type: 'number', required: true },
            previousEpochWasMissing: { type: 'boolean', required: true, default: false },
            desiredEpoch: { type: 'number', required: true },
            status: { type: 'string', required: true, default: 'pending' },
            version: { type: 'number', required: true, default: 0 },
            scanGeneration: { type: 'number', required: true, default: 1 },
            scanPage: { type: 'number', required: true, default: 1 },
            passDiscovered: { type: 'number', required: true, default: 0 },
            passIncomplete: { type: 'number', required: true, default: 0 },
            stablePasses: { type: 'number', required: true, default: 0 },
            leaseToken: { type: 'string' },
            leaseExpiresAt: { type: 'datetime' },
            lastError: { type: 'text' },
            lastErrorAt: { type: 'datetime' },
            activatedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['pendingOrganizationId'] },
            { fields: ['organizationId', 'status'] },
            { fields: ['status', 'leaseExpiresAt'] },
          ],
        },

        // Per-member receipts isolate provider failures and make response-loss
        // replay exact. They intentionally retain completed rows so a later
        // membership rescan never repeats settled work.
        organization_sso_revocation_receipts: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            transitionId: {
              type: 'string',
              required: true,
              references: { table: 'organization_sso_transitions', onDelete: 'CASCADE' },
            },
            organizationMemberId: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            scanGeneration: { type: 'number', required: true },
            status: { type: 'string', required: true, default: 'pending' },
            attemptCount: { type: 'number', required: true, default: 0 },
            lastAttemptAt: { type: 'datetime' },
            lastError: { type: 'text' },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['transitionId'] },
            { fields: ['transitionId', 'status'] },
            { fields: ['organizationMemberId'] },
          ],
        },

        organization_scim_tokens: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            label: { type: 'string', required: true },
            status: { type: 'string', default: 'active' },
            tokenPrefix: { type: 'string' },
            tokenHash: { type: 'string' },
            scopes: { type: 'json' },
            createdBy: { type: 'string' },
            lastUsedAt: { type: 'datetime' },
            expiresAt: { type: 'datetime' },
            revokedAt: { type: 'datetime' },
            revokedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['status'] },
            { fields: ['tokenPrefix'] },
          ],
        },

        organization_admin_tokens: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            label: { type: 'string', required: true },
            status: { type: 'string', default: 'active' },
            tokenPrefix: { type: 'string' },
            tokenHash: { type: 'string' },
            scopes: { type: 'json' },
            createdBy: { type: 'string' },
            lastUsedAt: { type: 'datetime' },
            expiresAt: { type: 'datetime' },
            revokedAt: { type: 'datetime' },
            revokedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['status'] },
            { fields: ['tokenPrefix'] },
          ],
        },

        organization_legal_holds: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            name: { type: 'string', required: true },
            status: { type: 'string', default: 'active' },
            reason: { type: 'text' },
            scope: { type: 'json' },
            createdBy: { type: 'string' },
            releasedAt: { type: 'datetime' },
            releasedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['organizationId', 'status'] },
            { fields: ['status'] },
            { fields: ['createdBy'] },
          ],
        },

        organization_admin_export_tasks: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            kind: { type: 'string', required: true },
            workspaceId: { type: 'string' },
            legalHoldId: { type: 'string' },
            requestingUserId: { type: 'string', required: true },
            exportType: { type: 'string', required: true },
            requestedFormat: { type: 'string', required: true },
            status: { type: 'string', default: 'queued' },
            request: { type: 'json' },
            requestHash: { type: 'string', required: true },
            idempotencyKeyHash: { type: 'string' },
            taskId: { type: 'string', required: true },
            tokenId: { type: 'string', required: true },
            result: { type: 'json' },
            error: { type: 'json' },
            createdBy: { type: 'string' },
            startedAt: { type: 'datetime' },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['kind'] },
            { fields: ['workspaceId'] },
            { fields: ['legalHoldId'] },
            { fields: ['status'] },
            { fields: ['taskId'] },
            { fields: ['tokenId'] },
            { fields: ['idempotencyKeyHash'] },
          ],
        },

        organization_audit_exports: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            status: { type: 'string', default: 'completed' },
            format: { type: 'string', default: 'jsonl' },
            filter: { type: 'json' },
            eventCount: { type: 'number' },
            content: { type: 'text' },
            createdBy: { type: 'string' },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['status'] },
            { fields: ['createdBy'] },
            { fields: ['completedAt'] },
          ],
        },

        organization_discovery_exports: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            status: { type: 'string', default: 'completed' },
            format: { type: 'string', default: 'jsonl' },
            filter: { type: 'json' },
            itemCount: { type: 'number' },
            content: { type: 'text' },
            createdBy: { type: 'string' },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['status'] },
            { fields: ['createdBy'] },
            { fields: ['completedAt'] },
          ],
        },

        organization_billing_records: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            kind: { type: 'string', default: 'contract' },
            status: { type: 'string', default: 'draft' },
            title: { type: 'string', required: true },
            externalId: { type: 'string' },
            amountCents: { type: 'number' },
            currency: { type: 'string', default: 'USD' },
            billingEmail: { type: 'string' },
            contractOwnerEmail: { type: 'string' },
            renewalAt: { type: 'datetime' },
            periodStart: { type: 'datetime' },
            periodEnd: { type: 'datetime' },
            metadata: { type: 'json' },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['organizationId', 'externalId'] },
            { fields: ['kind'] },
            { fields: ['status'] },
            { fields: ['renewalAt'] },
          ],
        },

        organization_billing_webhook_events: {
          schema: {
            eventId: { type: 'string', required: true, unique: true },
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            eventType: { type: 'string', required: true },
            billingRecordId: { type: 'string' },
            receivedAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['eventId'] },
            { fields: ['organizationId'] },
            { fields: ['eventType'] },
            { fields: ['receivedAt'] },
          ],
        },

        // ─── Workspaces ────────────────────────────────────────────────
        workspaces: {
          schema: {
            organizationId: {
              type: 'string',
              references: { table: 'organizations', onDelete: 'SET NULL' },
            },
            name: { type: 'string', required: true },
            icon: { type: 'string' }, // emoji or image url
            domain: { type: 'string' },
            ownerId: { type: 'string' },
            deletionPendingAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['ownerId'] },
            { fields: ['domain'] },
          ],
        },

        // ─── Teamspaces (workspace-local collaborative page areas) ────
        teamspaces: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            name: { type: 'string', required: true },
            icon: { type: 'string' },
            description: { type: 'text' },
            access: { type: 'string', required: true, default: 'open' }, // open | closed | private
            memberPageRole: { type: 'string', required: true, default: 'edit' },
            openPageRole: { type: 'string', required: true, default: 'view' },
            membersCanInvite: { type: 'boolean', required: true, default: true },
            membersCanEditSidebar: { type: 'boolean', required: true, default: true },
            archivedAt: { type: 'datetime' },
            archivedBy: { type: 'string' },
            // Random compare-and-swap token for same-millisecond writes.
            writeToken: { type: 'string' },
            createdBy: { type: 'string', required: true },
            updatedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['workspaceId', 'archivedAt', 'id'] },
            { fields: ['workspaceId', 'access', 'archivedAt', 'id'] },
            { fields: ['workspaceId', 'name', 'id'] },
          ],
        },

        teamspace_members: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            teamspaceId: {
              type: 'string',
              required: true,
              references: { table: 'teamspaces', onDelete: 'CASCADE' },
            },
            principalType: { type: 'string', required: true }, // user | group
            principalId: { type: 'string', required: true },
            // User principals bind to one exact workspace membership lifetime.
            // Removing/re-adding a user cannot resurrect this row.
            workspaceMemberId: { type: 'string' },
            role: { type: 'string', required: true, default: 'member' }, // owner | member
            createdBy: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['teamspaceId'] },
            { fields: ['principalId'] },
            { fields: ['workspaceId', 'principalId'] },
            { fields: ['teamspaceId', 'role', 'id'] },
            { fields: ['teamspaceId', 'principalType', 'principalId'], unique: true },
          ],
        },

        teamspace_join_requests: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            teamspaceId: {
              type: 'string',
              required: true,
              references: { table: 'teamspaces', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            workspaceMemberId: { type: 'string', required: true },
            status: { type: 'string', required: true, default: 'pending' }, // pending | approved | denied
            createdBy: { type: 'string', required: true },
            decidedBy: { type: 'string' },
            decidedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['teamspaceId'] },
            { fields: ['userId'] },
            { fields: ['teamspaceId', 'status', 'id'] },
            { fields: ['workspaceId', 'userId', 'status', 'id'] },
            { fields: ['teamspaceId', 'userId'], unique: true },
          ],
        },

        teamspace_settings: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            // Logical pointer so an archived/default transition can update both
            // rows in one workspace transaction without a cyclic FK cascade.
            defaultTeamspaceId: { type: 'string' },
            ownersOnlyCreate: { type: 'boolean', required: true, default: false },
            // Random compare-and-swap token for active-count/default/archive
            // transitions. updatedAt alone can repeat within one millisecond.
            lifecycleToken: { type: 'string' },
            updatedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'], unique: true },
            { fields: ['defaultTeamspaceId'] },
          ],
        },

        // ─── Pages (documents AND database containers AND database rows) ──
        pages: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            // Parent is another page/database (self-ref) or the workspace root.
            // Kept as a logical reference (no physical FK) to allow null roots.
            parentId: { type: 'string' },
            parentType: { type: 'string', default: 'workspace' }, // workspace | page | database
            // Only workspace-root pages carry this scalar. Descendants derive
            // their Teamspace through the bounded page ancestry walk.
            teamspaceId: { type: 'string' },
            teamspacePermissionMode: { type: 'string', default: 'inherit' }, // inherit | restricted
            kind: { type: 'string', default: 'page' }, // page | database

            title: { type: 'text' },
            icon: { type: 'string' }, // emoji char or image url/key
            iconType: { type: 'string', default: 'none' }, // none | emoji | image
            notionIcon: { type: 'json' },
            cover: { type: 'string' }, // image url/key
            notionCover: { type: 'json' },
            // Database-wide sub-item/dependency bindings. Property names stay
            // presentation-only; stable ids in this record own the feature.
            databaseFeatures: { type: 'json' },
            databaseFeaturesRevision: { type: 'number', default: 0 },
            // Canonical sub-item hierarchy edge. Empty means a database root;
            // children use the compound keyset below rather than an unbounded
            // parent-side JSON array.
            subitemParentId: { type: 'string', default: '' },
            // Exact live direct-child summary for zero-probe root windows.
            // Child IDs remain authoritative only through subitemParentId.
            subitemChildCount: { type: 'number', default: 0 },
            coverPosition: { type: 'number', default: 50 }, // 0–100 vertical focal point
            font: { type: 'string', default: 'default' }, // default | serif | mono
            smallText: { type: 'boolean', default: false },
            fullWidth: { type: 'boolean', default: false },
            isLocked: { type: 'boolean', default: false },
            isPublic: { type: 'boolean', default: false },
            backlinksDisplay: { type: 'string', default: 'default' }, // default | expanded | off
            pageCommentsDisplay: { type: 'string', default: 'default' }, // default | expanded | off
            isWiki: { type: 'boolean', default: false },
            // Root points to itself; descendants point to the owning wiki root.
            wikiRootId: { type: 'string' },
            verifiedAt: { type: 'datetime' },
            verifiedBy: { type: 'string' },
            verificationExpiresAt: { type: 'datetime' },

            // Column values when this page is a row in a database: { [propertyId]: value }
            properties: { type: 'json' },

            // Indexed import-owner locator. JSON properties keep the source
            // metadata for product behavior, while these scalar fields make
            // crash recovery/cancellation bounded and unambiguous.
            notionImportJobId: { type: 'string' },
            notionImportSourceId: { type: 'string' },
            notionImportSourceKind: { type: 'string' },
            // Native import owners stay durable but product-hidden until the
            // lease-fenced remap/finalization publication boundary.
            notionImportStaging: { type: 'boolean', default: false },

            isFavorite: { type: 'boolean', default: false },
            // Server-authenticated receipt for idempotent page/row outbox replay.
            lastMutationId: { type: 'string' },
            inTrash: { type: 'boolean', default: false },
            trashedAt: { type: 'datetime' },
            deletionPendingAt: { type: 'datetime' },

            // Ordering among siblings (fractional indexing-friendly; number for now).
            position: { type: 'number', default: 0 },

            createdBy: { type: 'string' },
            lastEditedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['parentId'] },
            { fields: ['inTrash'] },
            { fields: ['workspaceId', 'parentId'] },
            { fields: ['workspaceId', 'parentType'] },
            { fields: ['workspaceId', 'teamspaceId'] },
            { fields: ['workspaceId', 'parentType', 'teamspaceId', 'position', 'id'] },
            { fields: ['parentId', 'parentType'] },
            { fields: ['parentId', 'parentType', 'position', 'id'] },
            { fields: ['parentId', 'parentType', 'inTrash', 'position'] },
            { fields: ['parentId', 'parentType', 'inTrash', 'position', 'id'] },
            { fields: ['parentId', 'parentType', 'inTrash', 'id'] },
            { fields: ['parentId', 'parentType', 'inTrash', 'trashedAt', 'position', 'id'] },
            { fields: ['subitemParentId'] },
            { fields: ['parentId', 'parentType', 'subitemParentId', 'inTrash', 'position', 'id'] },
            { fields: ['parentId', 'parentType', 'subitemParentId', 'inTrash', 'trashedAt', 'position', 'id'] },
            { fields: ['wikiRootId'] },
            { fields: ['wikiRootId', 'inTrash', 'id'] },
            { fields: ['verificationExpiresAt', 'id'] },
            { fields: ['workspaceId', 'notionImportStaging', 'updatedAt', 'id'] },
            { fields: ['notionImportJobId'] },
            { fields: ['notionImportJobId', 'notionImportSourceId'] },
            { fields: ['notionImportJobId', 'notionImportSourceId', 'notionImportSourceKind'] },
          ],
          fts: ['title', 'properties'],
        },

        // Indexed page ownership for native wiki collection views. The page
        // row remains the authority; this table never grants access by itself.
        page_owners: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            wikiRootId: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['pageId'] },
            { fields: ['pageId', 'userId'] },
            { fields: ['wikiRootId'] },
            { fields: ['wikiRootId', 'userId', 'pageId'] },
          ],
        },

        // ─── Blocks (a page's body content) ──────────────────────────────
        blocks: {
          schema: {
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            // Parent block for nesting (toggle children, list children …). null = top level.
            parentId: { type: 'string' },
            type: { type: 'string', required: true }, // paragraph | heading_1 | to_do | ...
            // Rich text + type-specific props, e.g.
            //   { rich: [{text, marks, link}], checked, language, color, icon, url, ... }
            content: { type: 'json' },
            // Flattened text mirror, kept in sync on write, for full-text search.
            plainText: { type: 'text' },
            position: { type: 'number', default: 0 },
            createdBy: { type: 'string' },
            // Server-authenticated edit provenance and the latest idempotency
            // receipt. Neither field is accepted inside a client block patch.
            lastEditedBy: { type: 'string' },
            lastMutationId: { type: 'string' },
          },
          indexes: [
            { fields: ['pageId'] },
            { fields: ['pageId', 'id'] },
            { fields: ['parentId'] },
            { fields: ['pageId', 'parentId'] },
          ],
          fts: ['plainText', 'content'],
        },

        // ─── Database columns ────────────────────────────────────────────
        db_properties: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            notionImportJobId: { type: 'string' },
            notionDataSourceId: { type: 'string' },
            notionPropertyId: { type: 'string' },
            name: { type: 'string', required: true },
            description: { type: 'text' },
            // title | rich_text | number | select | multi_select | status | date |
            // person | checkbox | url | email | phone | files |
            // created_time | last_edited_time | created_by | last_edited_by |
            // relation | rollup | formula | unique_id | button | location |
            // verification | last_visited_time | place
            type: { type: 'string', required: true },
            // Type-specific config: { options:[{id,name,color}], numberFormat, dateFormat, ... }
            config: { type: 'json' },
            position: { type: 'number', default: 0 },
          },
          indexes: [
            { fields: ['databaseId'] },
            { fields: ['notionImportJobId'] },
            { fields: ['notionImportJobId', 'notionDataSourceId', 'notionPropertyId'] },
            { fields: ['databaseId', 'notionImportJobId', 'notionDataSourceId', 'notionPropertyId'] },
            { fields: ['type'] },
            { fields: ['type', 'id'] },
            { fields: ['databaseId', 'type'] },
            { fields: ['databaseId', 'type', 'id'] },
          ],
        },

        database_automations: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            name: { type: 'string', required: true },
            enabled: { type: 'boolean', required: true },
            scopeType: { type: 'string', required: true },
            viewId: {
              type: 'string',
              references: { table: 'db_views', onDelete: 'SET NULL' },
            },
            triggerType: { type: 'string', required: true },
            trigger: { type: 'json', required: true },
            actionDocument: { type: 'json', required: true },
            nextRunAt: { type: 'datetime' },
            status: { type: 'string', required: true },
            revision: { type: 'number', required: true },
            createdBy: { type: 'string', required: true },
            updatedBy: { type: 'string', required: true },
            pausedAt: { type: 'datetime' },
            pausedReason: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'enabled', 'id'] },
            { fields: ['databaseId', 'status', 'id'] },
            { fields: ['databaseId', 'triggerType', 'enabled', 'status', 'id'] },
            { fields: ['triggerType', 'status', 'nextRunAt', 'id'] },
            { fields: ['viewId'] },
          ],
        },

        automation_execution_receipts: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            sourceType: { type: 'string', required: true },
            sourceId: { type: 'string', required: true },
            triggerPageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            requestedBy: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            status: { type: 'string', required: true },
            result: { type: 'json', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'triggerPageId', 'id'] },
            { fields: ['databaseId', 'sourceId', 'id'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        database_automation_events: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            triggerKind: { type: 'string', required: true },
            origin: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            changedPropertyIds: { type: 'json', required: true },
            occurredAt: { type: 'string', required: true },
            state: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['state', 'id'] },
            { fields: ['state', 'occurredAt', 'id'] },
            { fields: ['databaseId', 'state', 'id'] },
            { fields: ['databaseId', 'rowId', 'id'] },
            { fields: ['databaseId', 'rowId', 'occurredAt', 'id'] },
            { fields: ['databaseId', 'mutationId'] },
          ],
        },

        database_automation_event_workers: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            leaseToken: { type: 'string' },
            leaseUntil: { type: 'datetime' },
            cursorOccurredAt: { type: 'datetime' },
            cursorEventId: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['leaseUntil', 'id'] },
          ],
        },

        database_automation_schedule_workers: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            leaseToken: { type: 'string' },
            leaseUntil: { type: 'datetime' },
            cursorNextRunAt: { type: 'datetime' },
            cursorAutomationId: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['leaseUntil', 'id'] },
          ],
        },

        database_automation_deliveries: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            ownerPageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            sourceType: { type: 'string', required: true },
            sourceId: { type: 'string', required: true },
            executionId: {
              type: 'string',
              references: { table: 'automation_execution_receipts', onDelete: 'CASCADE' },
            },
            automationId: {
              type: 'string',
              references: { table: 'database_automations', onDelete: 'CASCADE' },
            },
            automationRevision: { type: 'number' },
            actionId: { type: 'string', required: true },
            channel: { type: 'string', required: true },
            scheduledFor: { type: 'datetime', required: true },
            state: { type: 'string', required: true },
            attempts: { type: 'number', required: true },
            nextAttemptAt: { type: 'datetime', required: true },
            payload: { type: 'json', required: true },
            deliveredAt: { type: 'datetime' },
            failedAt: { type: 'datetime' },
            lastError: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['ownerPageId'] },
            { fields: ['sourceType', 'sourceId', 'id'] },
            { fields: ['executionId', 'id'] },
            { fields: ['state', 'nextAttemptAt', 'id'] },
            { fields: ['automationId', 'scheduledFor', 'id'] },
          ],
        },

        database_automation_delivery_workers: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            leaseToken: { type: 'string' },
            leaseUntil: { type: 'datetime' },
            cursorNextAttemptAt: { type: 'datetime' },
            cursorDeliveryId: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['leaseUntil', 'id'] },
          ],
        },

        // ─── Database property value indexes ───────────────────────────
        db_property_indexes: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            propertyId: {
              type: 'string',
              required: true,
              references: { table: 'db_properties', onDelete: 'CASCADE' },
            },
            propertyType: { type: 'string', required: true },
            valueKind: { type: 'string', required: true },
            stringValue: { type: 'string' },
            numberValue: { type: 'number' },
            dateValue: { type: 'string' },
            booleanValue: { type: 'boolean' },
            searchText: { type: 'text' },
            rowUpdatedAt: { type: 'datetime' },
            propertyUpdatedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'propertyId'] },
            { fields: ['databaseId', 'propertyType'] },
            { fields: ['databaseId', 'valueKind'] },
            { fields: ['databaseId', 'valueKind', 'stringValue'] },
            { fields: ['databaseId', 'propertyId', 'rowId'] },
            { fields: ['databaseId', 'propertyId', 'stringValue', 'rowId'] },
            { fields: ['rowId'] },
            { fields: ['propertyId'] },
            { fields: ['propertyType'] },
            { fields: ['valueKind'] },
            { fields: ['stringValue'] },
            { fields: ['numberValue'] },
            { fields: ['dateValue'] },
            { fields: ['booleanValue'] },
          ],
        },

        // Directed task dependencies stay one edge per row so predecessor and
        // successor projections remain cursor-bounded at unbounded degree.
        database_dependency_edges: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            dataKey: { type: 'string', default: '' },
            predecessorRowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            successorRowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'predecessorRowId', 'id'] },
            { fields: ['databaseId', 'successorRowId', 'id'] },
            { fields: ['databaseId', 'successorRowId', 'predecessorRowId', 'id'] },
            { fields: ['databaseId', 'predecessorRowId', 'successorRowId'] },
            { fields: ['databaseId', 'dataKey', 'predecessorRowId', 'id'] },
            { fields: ['databaseId', 'dataKey', 'successorRowId', 'id'] },
            { fields: ['databaseId', 'dataKey', 'successorRowId', 'predecessorRowId', 'id'] },
            { fields: ['databaseId', 'dataKey', 'predecessorRowId', 'successorRowId'] },
          ],
        },

        database_task_feature_config_receipts: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            feature: { type: 'string', required: true },
            operationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            requestedBy: { type: 'string', required: true },
            status: { type: 'string', required: true },
            result: { type: 'json', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId', 'feature', 'operationId'] },
          ],
        },

        database_task_feature_disable_jobs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            feature: { type: 'string', required: true },
            operationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            requestedBy: { type: 'string', required: true },
            phase: { type: 'string', required: true },
            dataKey: { type: 'string' },
            cursorPosition: { type: 'number', default: 0 },
            cursorId: { type: 'string', default: '' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId', 'feature'] },
            { fields: ['databaseId', 'feature', 'phase', 'cursorId'] },
          ],
        },

        database_dependency_validation_jobs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            featureRevision: { type: 'number', required: true },
            dataKey: { type: 'string' },
            requestedBy: { type: 'string', required: true },
            additions: { type: 'json', required: true },
            removals: { type: 'json', required: true },
            validationAdditionIndexes: { type: 'json', required: true },
            validationComplete: { type: 'boolean', required: true },
            failureMessage: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        database_dependency_validation_items: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'database_dependency_validation_jobs', onDelete: 'CASCADE' },
            },
            databaseId: { type: 'string', required: true },
            featureRevision: { type: 'number', required: true },
            additionIndex: { type: 'number', required: true },
            rowId: { type: 'string', required: true },
            edgeCursorId: { type: 'string', required: true },
            proposedScanned: { type: 'boolean', required: true },
            expanded: { type: 'boolean', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['jobId', 'id'] },
            { fields: ['databaseId'] },
            { fields: ['jobId', 'featureRevision', 'expanded', 'additionIndex', 'id'] },
            { fields: ['jobId', 'featureRevision', 'additionIndex', 'rowId'] },
          ],
        },

        database_dependency_mutation_receipts: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            resultRevision: { type: 'number', required: true },
            requestedBy: { type: 'string', required: true },
            status: { type: 'string', required: true },
            failureMessage: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        database_dependency_date_shift_jobs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            featureRevision: { type: 'number', required: true },
            dataKey: { type: 'string' },
            requestedBy: { type: 'string', required: true },
            dateMode: { type: 'string', required: true },
            datePropertyId: { type: 'string', required: true },
            startDatePropertyId: { type: 'string', required: true },
            endDatePropertyId: { type: 'string', required: true },
            shiftMode: { type: 'string', required: true },
            avoidWeekends: { type: 'boolean', required: true },
            deltaDays: { type: 'number', required: true },
            scanComplete: { type: 'boolean', required: true, default: false },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        database_dependency_date_shift_items: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'database_dependency_date_shift_jobs', onDelete: 'CASCADE' },
            },
            databaseId: { type: 'string', required: true },
            rowId: { type: 'string', required: true },
            depth: { type: 'number', required: true },
            sourceUpdatedAt: { type: 'string', required: true },
            previousValue: { type: 'string', required: true },
            previousEndValue: { type: 'string', required: true },
            nextValue: { type: 'string', required: true },
            nextEndValue: { type: 'string', required: true },
            edgeCursorId: { type: 'string', required: true },
            expanded: { type: 'boolean', required: true, default: false },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['jobId', 'expanded', 'depth', 'id'] },
            { fields: ['jobId', 'depth', 'id'] },
            { fields: ['jobId', 'rowId'], unique: true },
          ],
        },

        database_dependency_date_shift_receipts: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            mutationId: { type: 'string', required: true },
            requestHash: { type: 'string', required: true },
            requestedBy: { type: 'string', required: true },
            status: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        // Deep sub-item moves validate one bounded ancestor window per call.
        // Only this resumable cursor is persisted while the canonical page
        // parent scalar remains unchanged; the terminal request publishes the
        // row and database feature revision atomically, then removes the job.
        database_hierarchy_moves: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            targetParentId: { type: 'string', required: true },
            sourceParentId: { type: 'string', required: true },
            cursorAncestorId: { type: 'string', required: true },
            tortoiseAncestorId: { type: 'string', required: true },
            hareAncestorId: { type: 'string', required: true },
            featureRevision: { type: 'number', required: true },
            requestedBy: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        // A completed move remains replayable after later moves replace the
        // row-local lastMutationId. The receipt is immutable and is inserted
        // in the same transaction that publishes the row and feature revision.
        database_hierarchy_move_receipts: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rowId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            mutationId: { type: 'string', required: true },
            targetParentId: { type: 'string', required: true },
            resultRevision: { type: 'number', required: true },
            requestedBy: { type: 'string', required: true },
            completedAt: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rowId'] },
            { fields: ['databaseId', 'requestedBy', 'id'] },
          ],
        },

        database_hierarchy_lifecycle_jobs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            rootRowId: { type: 'string', required: true },
            operation: { type: 'string', required: true },
            trashStamp: { type: 'string', required: true },
            featureRevision: { type: 'number', required: true },
            requestedBy: { type: 'string', required: true },
            mutationId: { type: 'string' },
            phase: { type: 'string' },
            targetRootId: { type: 'string' },
            sourceParentId: { type: 'string' },
            relationPropertyCursorId: { type: 'string' },
            relationRowPosition: { type: 'number' },
            relationRowId: { type: 'string' },
            relationValueOffset: { type: 'number' },
            relationsPrepared: { type: 'boolean' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'rootRowId'] },
          ],
        },

        database_hierarchy_lifecycle_items: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'database_hierarchy_lifecycle_jobs', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            depth: { type: 'number', required: true },
            scanned: { type: 'boolean', required: true },
            scanLane: { type: 'string', required: true },
            scanPosition: { type: 'number', required: true },
            scanRowId: { type: 'string', required: true },
            targetRowId: { type: 'string' },
            prepared: { type: 'boolean' },
            applied: { type: 'boolean' },
            published: { type: 'boolean' },
            sourceUpdatedAt: { type: 'string' },
            blockScanId: { type: 'string' },
            blocksPrepared: { type: 'boolean' },
            blocksApplied: { type: 'boolean' },
            dependencyLane: { type: 'string' },
            dependencyCursorId: { type: 'string' },
            dependenciesPrepared: { type: 'boolean' },
            dependenciesApplied: { type: 'boolean' },
            fileCursorId: { type: 'string' },
            filesApplied: { type: 'boolean' },
            relationPropertyCursorId: { type: 'string' },
            relationValueOffset: { type: 'number' },
            relationsPrepared: { type: 'boolean' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['jobId', 'scanned', 'depth', 'id'] },
            { fields: ['jobId', 'depth', 'id'] },
            { fields: ['jobId', 'rowId'] },
            { fields: ['jobId', 'prepared', 'depth', 'id'] },
            { fields: ['jobId', 'applied', 'depth', 'id'] },
            { fields: ['jobId', 'published', 'depth', 'id'] },
            { fields: ['jobId', 'blocksPrepared', 'depth', 'id'] },
            { fields: ['jobId', 'blocksApplied', 'depth', 'id'] },
            { fields: ['jobId', 'dependenciesApplied', 'depth', 'id'] },
            { fields: ['jobId', 'dependenciesPrepared', 'depth', 'id'] },
            { fields: ['jobId', 'filesApplied', 'depth', 'id'] },
            { fields: ['jobId', 'relationsPrepared', 'depth', 'id'] },
          ],
        },

        database_hierarchy_relation_updates: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'database_hierarchy_lifecycle_jobs', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            sourceUpdatedAt: { type: 'string', required: true },
            properties: { type: 'json', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['jobId', 'id'] },
            { fields: ['jobId', 'rowId'] },
          ],
        },

        // ─── Bounded global database-query sort snapshots ─────────────
        database_query_snapshots: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            actorId: { type: 'string', required: true },
            fingerprint: { type: 'string', required: true },
            expiresAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['actorId'] },
            { fields: ['expiresAt', 'id'] },
            { fields: ['workspaceId', 'expiresAt', 'id'] },
          ],
        },

        database_query_snapshot_rows: {
          schema: {
            snapshotId: {
              type: 'string',
              required: true,
              references: { table: 'database_query_snapshots', onDelete: 'CASCADE' },
            },
            rowId: { type: 'string', required: true },
            sortKey: { type: 'text', required: true },
          },
          indexes: [
            { fields: ['snapshotId'] },
            { fields: ['snapshotId', 'rowId'] },
            { fields: ['snapshotId', 'sortKey', 'id'] },
          ],
        },

        // ─── Database saved views ────────────────────────────────────────
        db_views: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            notionImportJobId: { type: 'string' },
            notionDataSourceId: { type: 'string' },
            notionViewId: { type: 'string' },
            notionViewStructuralIndex: { type: 'number' },
            notionImportSnapshotRevision: { type: 'string' },
            notionViewFingerprint: { type: 'string' },
            notionRowContextJobId: { type: 'string' },
            notionRowContextSnapshotRevision: { type: 'string' },
            notionRowContextBlockId: { type: 'string' },
            notionRowContextSourceViewId: { type: 'string' },
            notionRowContextFingerprint: { type: 'string' },
            name: { type: 'string', default: 'Default view' },
            type: { type: 'string', required: true }, // table | board | list | gallery | calendar | timeline
            // { visibleProperties, propertyOrder, filters:[], sorts:[], groupBy, wrap, ... }
            config: { type: 'json' },
            position: { type: 'number', default: 0 },
          },
          indexes: [
            { fields: ['databaseId'] },
            { fields: ['notionImportJobId'] },
            { fields: ['notionImportJobId', 'notionDataSourceId', 'notionViewId'] },
            { fields: ['databaseId', 'notionImportJobId', 'notionDataSourceId', 'notionViewId'] },
            { fields: ['databaseId', 'notionImportJobId', 'notionDataSourceId', 'notionViewStructuralIndex'] },
            { fields: ['notionRowContextJobId'] },
            { fields: ['notionRowContextJobId', 'notionRowContextSnapshotRevision', 'notionRowContextBlockId'] },
            { fields: ['notionRowContextJobId', 'notionRowContextSnapshotRevision', 'notionRowContextBlockId', 'notionRowContextSourceViewId'] },
          ],
        },

        // Notion-compatible view query snapshots are intentionally short
        // lived. They preserve the official create/get/delete query contract
        // without treating a cached query as a durable view mutation.
        db_view_queries: {
          schema: {
            viewId: {
              type: 'string',
              required: true,
              references: { table: 'db_views', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            workspaceId: { type: 'string', required: true },
            rowIds: { type: 'json' },
            sourceCursor: { type: 'text' },
            hasMore: { type: 'boolean', default: false },
            filter: { type: 'json' },
            sorts: { type: 'json' },
            pageSize: { type: 'number', default: 100 },
            createdBy: { type: 'string' },
            expiresAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['viewId'] },
            { fields: ['databaseId'] },
            { fields: ['workspaceId'] },
            { fields: ['createdBy'] },
            { fields: ['expiresAt'] },
          ],
        },

        // ─── Database row/page templates ────────────────────────────────
        db_templates: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            notionImportJobId: { type: 'string' },
            notionTemplateId: { type: 'string' },
            notionDataSourceId: { type: 'string' },
            notionTemplateStructuralIndex: { type: 'number' },
            notionImportSnapshotRevision: { type: 'string' },
            notionTemplateFingerprint: { type: 'string' },
            name: { type: 'string', default: 'Untitled template' },
            icon: { type: 'string' },
            title: { type: 'text' },
            properties: { type: 'json' },
            blocks: { type: 'json' },
            isDefault: { type: 'boolean', default: false },
            position: { type: 'number', default: 0 },
          },
          indexes: [
            { fields: ['databaseId'] },
            { fields: ['databaseId', 'position'] },
            { fields: ['notionImportJobId', 'notionTemplateId'] },
            { fields: ['notionImportJobId', 'notionTemplateId', 'notionDataSourceId'] },
            {
              fields: [
                'notionImportJobId',
                'notionDataSourceId',
                'notionTemplateStructuralIndex',
                'notionImportSnapshotRevision',
                'notionTemplateFingerprint',
              ],
            },
          ],
        },

        // ─── Durable server-owned Notion import queue ────────────────
        // This control-plane row contains routing/lease metadata only.
        // Credentials remain encrypted in the workspace connection table and
        // are freshly decrypted by each bounded worker chunk.
        notion_import_run_queue: {
          schema: {
            jobId: { type: 'string', required: true, unique: true },
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            actorId: { type: 'string', required: true },
            state: { type: 'string', default: 'pending' }, // pending | leased
            dueAt: { type: 'datetime', required: true },
            leaseId: { type: 'string' },
            leaseExpiresAt: { type: 'datetime' },
            attempts: { type: 'number', default: 0 },
            missingJobChecks: { type: 'number', default: 0 },
            lastStartedAt: { type: 'datetime' },
            lastSettledAt: { type: 'datetime' },
            // Bounded machine code only; arbitrary upstream errors never enter
            // the central queue or its logs.
            lastErrorCode: { type: 'string' },
          },
          indexes: [
            { fields: ['jobId'] },
            { fields: ['workspaceId'] },
            { fields: ['state'] },
            { fields: ['dueAt'] },
            { fields: ['state', 'dueAt'] },
            { fields: ['state', 'leaseExpiresAt'] },
          ],
        },

        // ─── Notion API import connections/jobs ───────────────────────
        notion_import_connections: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            actorId: { type: 'string' },
            name: { type: 'string', default: 'Notion connection' },
            connectionKind: { type: 'string', default: 'internal_integration' },
            status: { type: 'string', default: 'active' }, // active | revoked | error
            apiVersion: { type: 'string', default: '2026-03-11' },
            notionWorkspaceId: { type: 'string' },
            notionWorkspaceName: { type: 'string' },
            tokenFingerprint: { type: 'string' },
            credentialAlgorithm: { type: 'string' },
            credentialKeyId: { type: 'string' },
            credentialCiphertext: { type: 'text' },
            metadata: { type: 'json' },
            lastValidatedAt: { type: 'datetime' },
            lastUsedAt: { type: 'datetime' },
            revokedAt: { type: 'datetime' },
            revokedBy: { type: 'string' },
            error: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['actorId'] },
            { fields: ['status'] },
            { fields: ['notionWorkspaceId'] },
          ],
        },

        // ─── Hosted MCP OAuth connections ─────────────────────────────
        mcp_oauth_clients: {
          schema: {
            clientId: { type: 'string', required: true },
            clientName: { type: 'string', default: 'MCP client' },
            redirectUris: { type: 'json' },
            grantTypes: { type: 'json' },
            responseTypes: { type: 'json' },
            tokenEndpointAuthMethod: { type: 'string', default: 'none' },
            clientUri: { type: 'string' },
            logoUri: { type: 'string' },
            // Confidential Notion-compatible clients store only a SHA-256
            // verifier; the plaintext secret never enters durable storage.
            notionCompatClientSecretHash: { type: 'string' },
            status: { type: 'string', default: 'active' },
            registeredBy: { type: 'string' },
            lastUsedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['clientId'] },
            { fields: ['status'] },
          ],
        },

        mcp_oauth_grants: {
          schema: {
            userId: { type: 'string', required: true },
            clientId: { type: 'string', required: true },
            clientName: { type: 'string', default: 'MCP client' },
            resource: { type: 'string', required: true },
            scopes: { type: 'json' },
            workspaceAccess: { type: 'string', default: 'selected' },
            workspaceIds: { type: 'json' },
            pageIds: { type: 'json' },
            databaseIds: { type: 'json' },
            readOnly: { type: 'boolean', default: false },
            status: { type: 'string', default: 'active' },
            expiresAt: { type: 'datetime' },
            lastUsedAt: { type: 'datetime' },
            revokedAt: { type: 'datetime' },
            revokedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['userId'] },
            { fields: ['clientId'] },
            { fields: ['status'] },
            { fields: ['expiresAt'] },
          ],
        },

        mcp_oauth_authorization_codes: {
          schema: {
            codeHash: { type: 'string', required: true },
            clientId: { type: 'string', required: true },
            redirectUri: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            grantId: {
              type: 'string',
              required: true,
              references: { table: 'mcp_oauth_grants', onDelete: 'CASCADE' },
            },
            resource: { type: 'string', required: true },
            scopes: { type: 'json' },
            codeChallenge: { type: 'string', required: true },
            codeChallengeMethod: { type: 'string', default: 'S256' },
            expiresAt: { type: 'datetime', required: true },
            consumedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['codeHash'] },
            { fields: ['clientId'] },
            { fields: ['userId'] },
            { fields: ['expiresAt'] },
          ],
        },

        mcp_oauth_refresh_tokens: {
          schema: {
            tokenHash: { type: 'string', required: true },
            grantId: {
              type: 'string',
              required: true,
              references: { table: 'mcp_oauth_grants', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            clientId: { type: 'string', required: true },
            scopes: { type: 'json' },
            resource: { type: 'string', required: true },
            status: { type: 'string', default: 'active' },
            expiresAt: { type: 'datetime' },
            lastUsedAt: { type: 'datetime' },
            revokedAt: { type: 'datetime' },
            revokedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['tokenHash'] },
            { fields: ['grantId'] },
            { fields: ['userId'] },
            { fields: ['clientId'] },
            { fields: ['status'] },
            { fields: ['expiresAt'] },
          ],
        },

        mcp_async_tasks: {
          schema: {
            grantId: {
              type: 'string',
              required: true,
              references: { table: 'mcp_oauth_grants', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            clientId: { type: 'string', required: true },
            status: { type: 'string', default: 'queued' },
            operation: { type: 'json' },
            result: { type: 'json' },
            error: { type: 'json' },
            pollAfterSeconds: { type: 'number', default: 1 },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['grantId'] },
            { fields: ['userId'] },
            { fields: ['clientId'] },
            { fields: ['status'] },
          ],
        },

        notion_import_jobs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            source: { type: 'string', default: 'notion_api' },
            connectionKind: { type: 'string', default: 'personal_access_token' },
            connectionId: { type: 'string' },
            status: { type: 'string', default: 'queued' }, // queued | discovering | ready | completed | failed | cancelled
            phase: { type: 'string', default: 'queued' },
            actorId: { type: 'string' },
            parentPageId: { type: 'string' },
            rootNotionPageIds: { type: 'json' },
            rootNotionDataSourceIds: { type: 'json' },
            notionWorkspaceId: { type: 'string' },
            notionWorkspaceName: { type: 'string' },
            apiVersion: { type: 'string', default: '2026-03-11' },
            options: { type: 'json' },
            counts: { type: 'json' },
            progress: { type: 'json' },
            report: { type: 'json' },
            error: { type: 'text' },
            retryOfJobId: { type: 'string' },
            startedAt: { type: 'datetime' },
            finishedAt: { type: 'datetime' },
            cancelledAt: { type: 'datetime' },
            cancelledBy: { type: 'string' },
            // Terminal imports enqueue file checkpoint cleanup here. The
            // request path never scans the whole workspace just to retire
            // copied objects; scheduled maintenance drains this indexed,
            // durable continuation and marks it complete.
            fileCleanupStatus: { type: 'string' }, // pending | complete
            fileCleanupRequestedAt: { type: 'datetime' },
            fileCleanupCompletedAt: { type: 'datetime' },
            // Copy-on-write pointer for crash-safe discovery snapshot replacement.
            activeItemGeneration: { type: 'string' },
            // Changes whenever the active discovery graph changes. Apply uses
            // this internal revision to reuse one immutable graph snapshot
            // across bounded HTTP chunks without accepting a stale append.
            itemSnapshotRevision: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['actorId'] },
            { fields: ['status'] },
            { fields: ['source'] },
            { fields: ['fileCleanupStatus'] },
            { fields: ['fileCleanupStatus', 'fileCleanupRequestedAt'] },
            { fields: ['fileCleanupStatus', 'status', 'fileCleanupRequestedAt'] },
          ],
        },

        notion_import_items: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'notion_import_jobs', onDelete: 'CASCADE' },
            },
            // Optional for compatibility with pre-generation import rows.
            itemGeneration: { type: 'string' },
            notionId: { type: 'string', required: true },
            notionObject: { type: 'string', required: true },
            parentNotionId: { type: 'string' },
            title: { type: 'text' },
            status: { type: 'string', default: 'discovered' },
            phase: { type: 'string', default: 'discovery' },
            // Scalar companion to the heavy metadata snapshot. Incremental
            // discovery projects this field without loading metadata JSON.
            enrichmentComplete: { type: 'boolean' },
            localId: { type: 'string' },
            localType: { type: 'string' },
            metadata: { type: 'json' },
            error: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['jobId'] },
            { fields: ['jobId', 'itemGeneration'] },
            { fields: ['jobId', 'itemGeneration', 'notionId'] },
            { fields: ['notionId'] },
            { fields: ['status'] },
            { fields: ['workspaceId', 'notionId'] },
            { fields: ['jobId', 'notionId'] },
            { fields: ['jobId', 'status'] },
          ],
        },

        notion_import_mappings: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              references: { table: 'notion_import_jobs', onDelete: 'CASCADE' },
            },
            // Optional for existing imports. New mappings always set this
            // canonical key; UNIQUE closes concurrent/replayed apply races.
            mappingKey: { type: 'string', unique: true },
            notionId: { type: 'string', required: true },
            notionType: { type: 'string', required: true },
            localId: { type: 'string', required: true },
            localType: { type: 'string', required: true },
            relationKind: { type: 'string', default: 'canonical' },
            metadata: { type: 'json' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['jobId'] },
            { fields: ['mappingKey'] },
            { fields: ['notionId'] },
            { fields: ['localId'] },
            { fields: ['workspaceId', 'notionId'] },
            { fields: ['workspaceId', 'localId'] },
            { fields: ['jobId', 'notionId'] },
            { fields: ['jobId', 'localType', 'relationKind', 'localId'] },
            { fields: ['workspaceId', 'relationKind'] },
          ],
        },

        notion_import_apply_locks: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            jobId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'notion_import_jobs', onDelete: 'CASCADE' },
            },
            leaseId: { type: 'string', required: true },
            actorId: { type: 'string', required: true },
            purpose: { type: 'string', default: 'apply' }, // apply | discover
            expiresAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['jobId'] },
            { fields: ['expiresAt'] },
          ],
        },

        // ─── Comments ────────────────────────────────────────────────────
        comments: {
          schema: {
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            blockId: { type: 'string' }, // anchored block (null = page-level discussion)
            parentId: { type: 'string' }, // thread parent comment
            authorId: { type: 'string', required: true },
            body: { type: 'json' }, // rich text
            resolved: { type: 'boolean', default: false },
          },
          indexes: [
            { fields: ['pageId'] },
            { fields: ['blockId'] },
          ],
        },

        // ─── File upload grants and audit trail ───────────────────────
        file_uploads: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            bucket: { type: 'string', default: 'files' },
            key: { type: 'string', required: true },
            scope: { type: 'string', default: 'uploads' },
            pageId: {
              type: 'string',
              references: { table: 'pages', onDelete: 'SET NULL' },
            },
            blockId: {
              type: 'string',
              references: { table: 'blocks', onDelete: 'SET NULL' },
            },
            commentId: {
              type: 'string',
              references: { table: 'comments', onDelete: 'SET NULL' },
            },
            databaseId: {
              type: 'string',
              references: { table: 'pages', onDelete: 'SET NULL' },
            },
            propertyId: {
              type: 'string',
              references: { table: 'db_properties', onDelete: 'SET NULL' },
            },
            templateId: {
              type: 'string',
              references: { table: 'db_templates', onDelete: 'SET NULL' },
            },
            name: { type: 'string', required: true },
            contentType: { type: 'string' },
            size: { type: 'number', default: 0 },
            etag: { type: 'string' },
            status: { type: 'string', default: 'pending' }, // preparing | pending | uploaded | deleting | deleted | expired
            url: { type: 'string' },
            createdBy: { type: 'string' },
            expiresAt: { type: 'datetime' },
            completedAt: { type: 'datetime' },
            // Set only after maintenance proves an old completed upload still
            // has an authoritative content owner. Later detach/restore writes
            // change status through the file-reference state machine, so the
            // same attached row never pins the first orphan candidate window.
            orphanReferenceCheckedAt: { type: 'datetime' },
            expiredAt: { type: 'datetime' },
            deletedAt: { type: 'datetime' },
            deletedBy: { type: 'string' },
            deletionPreviousStatus: { type: 'string' },
            // Durable Notion pre-copy locator. Keep this on the upload itself:
            // a worker can die after writing bytes but before an owner exists.
            notionImportJobId: { type: 'string' },
            notionImportSnapshotRevision: { type: 'string' },
            notionImportSlotKey: { type: 'string', unique: true },
            // A failed pre-copy can finish its deterministic object PUT after
            // the retiring worker deleted the key. Schedule one delayed
            // idempotent delete beyond the maximum signed-PUT lifetime. The
            // maintenance worker clears this marker after success, so old
            // tombstones never consume the sweep budget forever.
            notionImportTerminalSweepAfter: { type: 'datetime' },
            notionImportTerminalSweepCompletedAt: { type: 'datetime' },
            mode: { type: 'string' }, // single_part | multi_part | external_url
            numberOfPartsTotal: { type: 'number' },
            numberOfPartsSent: { type: 'number' },
            multipartUploadId: { type: 'string' },
            multipartParts: { type: 'json' },
            externalUrl: { type: 'string' },
            fileImportResult: { type: 'json' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['key'] },
            { fields: ['url'] },
            { fields: ['pageId'] },
            { fields: ['pageId', 'id'] },
            { fields: ['blockId'] },
            { fields: ['commentId'] },
            { fields: ['databaseId'] },
            { fields: ['propertyId'] },
            { fields: ['templateId'] },
            { fields: ['createdBy'] },
            { fields: ['status'] },
            { fields: ['expiresAt'] },
            { fields: ['status', 'expiresAt'] },
            { fields: ['status', 'expiresAt', 'updatedAt'] },
            { fields: ['status', 'expiresAt', 'updatedAt', 'createdAt'] },
            { fields: ['status', 'completedAt'] },
            { fields: ['status', 'orphanReferenceCheckedAt', 'completedAt'] },
            { fields: ['status', 'orphanReferenceCheckedAt', 'completedAt', 'updatedAt'] },
            { fields: ['status', 'orphanReferenceCheckedAt', 'completedAt', 'updatedAt', 'createdAt'] },
            { fields: ['status', 'updatedAt'] },
            { fields: ['status', 'createdAt'] },
            { fields: ['status', 'completedAt', 'updatedAt', 'createdAt'] },
            { fields: ['notionImportJobId'] },
            { fields: ['notionImportJobId', 'notionImportSnapshotRevision'] },
            { fields: ['notionImportJobId', 'status'] },
            { fields: ['notionImportSlotKey'] },
            { fields: ['notionImportTerminalSweepAfter'] },
          ],
        },

        // Durable idempotency and terminal ownership for lossless native
        // archive imports. One row per caller-generated batch makes an
        // unobserved successful Function response replayable without reading
        // storage again, and fences cancellation away from imported bytes.
        native_archive_imports: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            batchId: { type: 'string', required: true },
            actorId: { type: 'string', required: true },
            documentSha256: { type: 'string', required: true },
            fileCount: { type: 'number', required: true },
            fileBytes: { type: 'number', required: true },
            parentId: { type: 'string' },
            parentType: { type: 'string', required: true },
            status: { type: 'string', required: true, default: 'preparing' },
            result: { type: 'json' },
            expiresAt: { type: 'datetime' },
            completedAt: { type: 'datetime' },
            cancelledAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['batchId'] },
            { fields: ['actorId'] },
            { fields: ['status'] },
            { fields: ['expiresAt'] },
            { fields: ['workspaceId', 'status'] },
          ],
        },

        // Atomically coordinates metadata/object/quota transitions with
        // permanent deletion. Compatible database-local requests may share
        // the row; workspace-wide and recovery owners remain exclusive.
        // Ordinary expired leases are replaceable; a lease carrying
        // recoveryData must be completed by maintenance after a worker crash.
        file_workspace_locks: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            leaseId: { type: 'string', required: true },
            actorId: { type: 'string', required: true },
            operation: { type: 'string', required: true },
            // Durable crash-recovery marker for multi-step file operations.
            // Ordinary leases keep this null; an expired non-null marker must
            // be recovered before another operation may replace the lock.
            recoveryData: { type: 'json' },
            // Short request-owned operations may share this one atomic
            // workspace coordination row only when their exact resource keys
            // are compatible. Workspace-wide/recovery owners leave it empty.
            compatibleScopes: { type: 'json' },
            revisionId: { type: 'string' },
            expiresAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['expiresAt'] },
          ],
        },

        // ─── File maintenance run history ──────────────────────────────
        file_maintenance_runs: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            kind: { type: 'string', default: 'expired-upload-cleanup' },
            actorId: { type: 'string' },
            status: { type: 'string', default: 'success' }, // success | partial_failure | failed
            scheduledAt: { type: 'datetime' },
            startedAt: { type: 'datetime', required: true },
            finishedAt: { type: 'datetime', required: true },
            scanned: { type: 'number', default: 0 },
            expired: { type: 'number', default: 0 },
            deletedObjects: { type: 'number', default: 0 },
            failedObjects: { type: 'number', default: 0 },
            failures: { type: 'json' },
            details: { type: 'json' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['kind'] },
            { fields: ['status'] },
            { fields: ['startedAt'] },
          ],
        },

        // Scalar routing hints for the scheduled workspace-local maintenance
        // worker. Content remains in the per-workspace DO; generation fences a
        // stale worker from clearing a newer best-effort DB-trigger hint.
        file_maintenance_queue: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            dueAt: { type: 'datetime', required: true },
            availableAt: { type: 'datetime', required: true },
            claimUntil: { type: 'datetime' },
            generation: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['dueAt'] },
            { fields: ['dueAt', 'workspaceId'] },
            { fields: ['availableAt'] },
            { fields: ['availableAt', 'workspaceId'] },
          ],
        },

        // One bounded rotating-audit cursor repairs any best-effort trigger
        // hint that was lost across the workspace-DO -> central-DO boundary.
        file_maintenance_sweep_state: {
          schema: {
            cursorWorkspaceId: { type: 'string' },
          },
          indexes: [
            { fields: ['cursorWorkspaceId'] },
          ],
        },

        // One scalar route per workspace wakes the automation scheduler and
        // delivery outbox without copying either authority into the central
        // block. Generation fences preserve a newer hint across an older run.
        database_automation_workspace_wakes: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            dueAt: { type: 'datetime', required: true },
            availableAt: { type: 'datetime', required: true },
            claimUntil: { type: 'datetime' },
            generation: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['dueAt'] },
            { fields: ['dueAt', 'workspaceId'] },
            { fields: ['availableAt'] },
            { fields: ['availableAt', 'workspaceId'] },
          ],
        },

        // A separately reserved rotating audit lane repairs a lost best-effort
        // workspace-to-central wake without scanning every tenant per minute.
        database_automation_wake_sweep_state: {
          schema: {
            cursorWorkspaceId: { type: 'string' },
          },
          indexes: [
            { fields: ['cursorWorkspaceId'] },
          ],
        },

        // ─── User notification inbox ──────────────────────────────────
        notifications: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            activityKey: { type: 'string', required: true },
            kind: { type: 'string', required: true }, // comment | mention | link | page_edit | system
            pageId: {
              type: 'string',
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            blockId: {
              type: 'string',
              references: { table: 'blocks', onDelete: 'SET NULL' },
            },
            commentId: {
              type: 'string',
              references: { table: 'comments', onDelete: 'CASCADE' },
            },
            actorId: { type: 'string' },
            title: { type: 'text' },
            preview: { type: 'text' },
            target: { type: 'string' },
            metadata: { type: 'json' },
            occurredAt: { type: 'datetime', required: true },
            readAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['userId'] },
            { fields: ['activityKey'] },
            { fields: ['kind'] },
            { fields: ['pageId'] },
            { fields: ['readAt'] },
            { fields: ['occurredAt'] },
          ],
        },

        // Central routing-only expiry queue. Scheduled work must re-read the
        // workspace page and current owners before delivering anything.
        wiki_verification_queue: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            pageId: { type: 'string', required: true },
            expiresAt: { type: 'datetime', required: true },
            state: { type: 'string', required: true, default: 'pending' },
            attempts: { type: 'number', required: true, default: 0 },
            nextAttemptAt: { type: 'datetime' },
            lastError: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['pageId'] },
            { fields: ['expiresAt'] },
            { fields: ['state', 'expiresAt', 'id'] },
            { fields: ['nextAttemptAt', 'id'] },
          ],
        },

        // One durable delivery state per verification expiry and current owner.
        // A deterministic idempotency key protects configured email webhooks
        // across worker retries and post-send persistence failures.
        wiki_verification_email_deliveries: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            pageId: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            expiresAt: { type: 'datetime', required: true },
            email: { type: 'string' },
            status: { type: 'string', required: true },
            attempts: { type: 'number', required: true, default: 0 },
            lastError: { type: 'text' },
            sentAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['pageId', 'expiresAt'] },
            { fields: ['userId', 'status', 'id'] },
            { fields: ['status', 'updatedAt', 'id'] },
          ],
        },

        // ─── Workspace members ─────────────────────────────────────────
        workspace_members: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            userId: { type: 'string', required: true },
            displayName: { type: 'string' },
            email: { type: 'string' },
            avatar: { type: 'string' },
            role: { type: 'string', default: 'member' }, // owner | admin | member | guest
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['userId'] },
            { fields: ['workspaceId', 'userId'] },
            { fields: ['workspaceId', 'id'] },
          ],
        },

        // ─── Workspace email invitations ───────────────────────────────
        workspace_invitations: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            email: { type: 'string', required: true },
            displayName: { type: 'string' },
            role: { type: 'string', default: 'member' }, // admin | member | guest
            token: { type: 'string', required: true },
            status: { type: 'string', default: 'pending' }, // pending | accepted | revoked | expired
            emailDeliveryStatus: { type: 'string', default: 'unsent' }, // unsent | sent | failed | not_configured
            emailMessageId: { type: 'string' },
            emailDeliveredAt: { type: 'datetime' },
            emailDeliveryError: { type: 'string' },
            createdBy: { type: 'string' },
            acceptedBy: { type: 'string' },
            acceptedAt: { type: 'datetime' },
            expiresAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['email'] },
            { fields: ['token'] },
            { fields: ['status'] },
          ],
        },

        // ─── Page permissions ──────────────────────────────────────────
        page_permissions: {
          schema: {
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            principalType: { type: 'string', default: 'email' }, // user | email | group | integration
            principalId: { type: 'string' },
            label: { type: 'string', required: true },
            role: { type: 'string', default: 'view' }, // view | comment | edit | full_access
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['pageId'] },
            { fields: ['workspaceId'] },
            { fields: ['principalId'] },
            { fields: ['workspaceId', 'pageId'] },
            { fields: ['workspaceId', 'principalId'] },
            { fields: ['pageId', 'principalId'] },
            { fields: ['pageId', 'workspaceId', 'principalType', 'principalId', 'role'] },
          ],
        },

        // Workspace-local authority cache for indexed search. Organization
        // group membership remains centrally authoritative, but related-search
        // SQL must apply every grant inside one workspace database before
        // LIMIT/cursor state. Search refreshes these versioned rows in bounded
        // keyset chunks and ignores stale versions immediately.
        search_group_authorities: {
          schema: {
            workspaceId: { type: 'string', required: true },
            organizationId: { type: 'string', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['organizationId'] },
            { fields: ['workspaceId', 'organizationId'] },
          ],
        },
        search_group_memberships: {
          schema: {
            workspaceId: { type: 'string', required: true },
            organizationId: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            organizationMemberId: { type: 'string', required: true },
            groupId: {
              type: 'string',
              required: true,
              references: { table: 'search_group_authorities', onDelete: 'CASCADE' },
            },
            sourceMembershipId: { type: 'string', required: true },
            policyVersion: { type: 'number', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['groupId'] },
            { fields: ['workspaceId', 'userId', 'policyVersion'] },
            { fields: ['workspaceId', 'organizationMemberId', 'policyVersion'] },
            {
              fields: [
                'groupId',
                'workspaceId',
                'organizationId',
                'userId',
                'organizationMemberId',
                'policyVersion',
              ],
            },
            { fields: ['workspaceId', 'userId', 'groupId'], unique: true },
          ],
        },
        search_group_membership_snapshots: {
          schema: {
            workspaceId: { type: 'string', required: true },
            organizationId: { type: 'string', required: true },
            userId: { type: 'string', required: true },
            organizationMemberId: { type: 'string', required: true },
            policyVersion: { type: 'number', required: true },
            syncAfter: { type: 'string' },
            syncComplete: { type: 'boolean', default: false },
            completedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['workspaceId', 'userId'], unique: true },
            { fields: ['workspaceId', 'userId', 'policyVersion'] },
          ],
        },
        // ─── Public share links ────────────────────────────────────────
        share_links: {
          schema: {
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            token: { type: 'string', required: true },
            enabled: { type: 'boolean', default: false },
            role: { type: 'string', default: 'view' }, // public links are view-only for now
            expiresAt: { type: 'datetime' },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['pageId'] },
            { fields: ['workspaceId'] },
            { fields: ['token'] },
            { fields: ['enabled'] },
          ],
        },

        // Workspace-authoritative Notion-style site configuration. Route
        // discovery is mirrored centrally, but anonymous reads must match this
        // row's exact enabled revision before content can be exposed.
        sites: {
          schema: {
            pageId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            slug: { type: 'string', required: true },
            published: { type: 'boolean', required: true, default: false },
            title: { type: 'string', required: true },
            description: { type: 'string' },
            theme: { type: 'string', required: true, default: 'system' },
            showBreadcrumbs: { type: 'boolean', required: true, default: true },
            showSearch: { type: 'boolean', required: true, default: true },
            showBranding: { type: 'boolean', required: true, default: true },
            navigationPageIds: { type: 'json', required: true },
            customHostname: { type: 'string' },
            domainStatus: { type: 'string', required: true, default: 'none' },
            domainVerificationToken: { type: 'string' },
            revision: { type: 'number', required: true, default: 1 },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['pageId'], unique: true },
            { fields: ['workspaceId'] },
            { fields: ['workspaceId', 'slug'], unique: true },
            { fields: ['published'] },
          ],
        },

        // Narrow definition/submit capability for one exact form view. This
        // never grants page/database read access and is separate from shares.
        form_links: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            viewId: {
              type: 'string',
              required: true,
              unique: true,
              references: { table: 'db_views', onDelete: 'CASCADE' },
            },
            token: { type: 'string', required: true, unique: true },
            audience: { type: 'string', required: true, default: 'none' },
            enabled: { type: 'boolean', default: false },
            createdBy: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['databaseId'] },
            { fields: ['viewId'], unique: true },
            { fields: ['token'], unique: true },
            { fields: ['enabled'] },
          ],
        },

        // ─── Page collaboration operation log + durable CRDT state ─────
        collaboration_operations: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            blockId: {
              type: 'string',
              references: { table: 'blocks', onDelete: 'SET NULL' },
            },
            clientId: { type: 'string', required: true },
            kind: { type: 'string', default: 'text' }, // text | text_snapshot | crdt_update | block_structure | block | presence-replay
            operation: { type: 'json' },
            beforeText: { type: 'text' },
            afterText: { type: 'text' },
            revision: { type: 'number', default: 0 },
            actorId: { type: 'string' },
            occurredAt: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['pageId'] },
            { fields: ['blockId'] },
            { fields: ['clientId'] },
            { fields: ['occurredAt'] },
          ],
        },
        collaboration_documents: {
          schema: {
            workspaceId: {
              type: 'string',
              required: true,
              references: { table: 'workspaces', onDelete: 'CASCADE' },
            },
            pageId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            blockId: {
              type: 'string',
              references: { table: 'blocks', onDelete: 'SET NULL' },
            },
            documentId: { type: 'string', required: true },
            engine: { type: 'string', default: 'yjs' },
            schemaVersion: { type: 'number', default: 1 },
            stateBase64: { type: 'text', required: true },
            stateVectorBase64: { type: 'text' },
            updateCount: { type: 'number', default: 0 },
            lastOperationId: {
              type: 'string',
              references: { table: 'collaboration_operations', onDelete: 'SET NULL' },
            },
            lastOperationRevision: { type: 'number', default: 0 },
            lastOperationOccurredAt: { type: 'datetime' },
            checkpointedAt: { type: 'datetime' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['pageId'] },
            { fields: ['blockId'] },
            { fields: ['documentId'] },
          ],
        },
        // Workspace-local durable handoff for central organization audit rows.
        // The primary content mutation and this row commit together; scheduled
        // maintenance retries the idempotent central insert after outages.
        organization_audit_outbox: {
          schema: {
            workspaceId: { type: 'string', required: true },
            organizationId: { type: 'string', required: true },
            actorId: { type: 'string' },
            action: { type: 'string', required: true },
            targetType: { type: 'string' },
            targetId: { type: 'string' },
            metadata: { type: 'json' },
            occurredAt: { type: 'datetime', required: true },
            attempts: { type: 'number', default: 0 },
            lastError: { type: 'text' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['workspaceId', 'id'] },
            { fields: ['organizationId'] },
            { fields: ['occurredAt'] },
          ],
        },
        // Per-workspace mutation feed (local-first delta sync, roadmap §7).
        // Entries deliberately carry NO foreign keys: deletion entries must
        // outlive the records they describe (they are the tombstones).
        change_log: {
          schema: {
            workspaceId: { type: 'string', required: true },
            tbl: { type: 'string', required: true },
            recordId: { type: 'string', required: true },
            scope: { type: 'string' },
            deleted: { type: 'boolean', default: false },
            at: { type: 'datetime', required: true },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['at'] },
            { fields: ['tbl'] },
            { fields: ['workspaceId', 'createdAt', 'id'] },
            { fields: ['workspaceId', 'tbl'] },
          ],
        },
      } satisfies Record<string, unknown>;

// Content tables live in the per-workspace dynamic block. The list is shared
// with the routing layer so table placement and runtime routing cannot drift.
const workspaceContentTableNames = WORKSPACE_CONTENT_TABLES;

// Cross-block foreign keys cannot exist: the workspace block copy of each
// content table drops `references` that point at central tables while
// keeping intra-content FKs (e.g. blocks.pageId -> pages).
function stripCentralReferences(tableConfig: Record<string, unknown>): Record<string, unknown> {
  const contentTables = new Set<string>(workspaceContentTableNames);
  const schema = tableConfig.schema as Record<string, Record<string, unknown>> | undefined;
  if (!schema) return tableConfig;
  const nextSchema: Record<string, Record<string, unknown>> = {};
  for (const [field, def] of Object.entries(schema)) {
    const ref = def.references as { table?: string } | undefined;
    if (ref?.table && !contentTables.has(ref.table)) {
      const { references: _dropped, ...rest } = def;
      nextSchema[field] = rest;
    } else {
      nextSchema[field] = def;
    }
  }
  return { ...tableConfig, schema: nextSchema };
}

const workspaceBlockTables = Object.fromEntries(
  workspaceContentTableNames.map((name) => [
    name,
    stripCentralReferences(appTables[name] as Record<string, unknown>),
  ]),
);

const contentTableNameSet = new Set<string>(workspaceContentTableNames);

// The symmetric strip for the central side: central tables (notifications,
// workspace_invitations, ...) may declare FKs onto content tables that no
// longer live in this block after the split — and the old central tables those
// FKs physically pointed at stop receiving new rows, so every split-mode insert
// would violate them (SQLITE_CONSTRAINT). Split mode drops those references;
// referential cleanup for cross-block deletes is handled by the cascade
// decompositions instead (docs/workspace-do-migration.md).
function stripContentReferences(tableConfig: Record<string, unknown>): Record<string, unknown> {
  const schema = tableConfig.schema as Record<string, Record<string, unknown>> | undefined;
  if (!schema) return tableConfig;
  const nextSchema: Record<string, Record<string, unknown>> = {};
  for (const [field, def] of Object.entries(schema)) {
    const ref = def.references as { table?: string } | undefined;
    if (ref?.table && contentTableNameSet.has(ref.table)) {
      const { references: _dropped, ...rest } = def;
      nextSchema[field] = rest;
    } else {
      nextSchema[field] = def;
    }
  }
  return { ...tableConfig, schema: nextSchema };
}

const centralTables = Object.fromEntries(
  Object.entries(appTables)
    .filter(([name]) => !contentTableNameSet.has(name))
    .map(([name, table]) => [name, stripContentReferences(table as Record<string, unknown>)]),
);

export default defineConfig({
  functions: {
    // The self-host appliance advances file/object recovery in ten-row slices.
    // Leave enough room for one large-workspace owner snapshot without letting
    // a broken scheduled function monopolize the runtime indefinitely.
    scheduleFunctionTimeout: '30s',
  },
  // Product data is functions-only. Release mode makes every raw DB resource
  // without an explicit access rule deny-by-default in local, packaged, and
  // deployed runtimes instead of silently bypassing authorization in dev.
  release: true,
  // OAuth callback construction must never inherit an arbitrary request Host.
  // The localhost fallback fails closed for optional OAuth in release mode;
  // operators enabling it provide HANJI_AUTH_ORIGIN (or the legacy app origin).
  baseUrl: AUTH_ORIGIN,
  // The Docker appliance enables its browser installer and trusted proxy mode
  // together so NAS/Desktop users do not need to discover proxy env flags.
  // Other runtimes remain fail-closed unless they opt in explicitly.
  trustSelfHostedProxy: TRUST_SELF_HOSTED_PROXY,

  frontend: {
    directory: '../web/dist',
    mountPath: '/',
    spaFallback: true,
    headers: {
      'Content-Security-Policy': [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "script-src 'self' https://challenges.cloudflare.com",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob: https:",
        "media-src 'self' blob: https:",
        "font-src 'self' data:",
        // `self` already covers the same-origin API in local and hosted
        // runtimes. The separate Vite dev page owns its own response headers;
        // authorizing plaintext loopback targets here would unnecessarily
        // widen the CSP shipped by HTTPS self-host and public deployments.
        "connect-src 'self' https: wss:",
        "frame-src 'self' https:",
        "worker-src 'self' blob:",
        "manifest-src 'self'",
      ].join('; '),
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
  },

  databases: {
    // Central control plane only; content lives in the per-workspace dynamic
    // block below.
    app: {
      tables: centralTables,
    },

    // Per-workspace dynamic block (docs/workspace-do-migration.md). Instance
    // creation is deny-by-default (no canCreate), which limits bootstrap to
    // trusted server contexts — the product's functions-only access model.
    workspace: {
      instance: true,
      tables: workspaceBlockTables,
    },

  },

  auth: {
    emailAuth: true,
    allowedOAuthProviders: ALLOWED_OAUTH_PROVIDERS,
    oauth: OAUTH_PROVIDERS,
    // Dev bootstrap only. Do not even register /signin/anonymous unless the
    // build/runtime was explicitly started with the local development flag.
    // The per-request loopback rule below remains defense in depth.
    anonymousAuth: ALLOW_DEV_GUEST_LOGIN,
    // Browser clients opt into EdgeBase's HttpOnly refresh-cookie transport.
    // Access tokens remain short-lived and memory-only, while the rotating
    // refresh credential is never exposed to application JavaScript.
    session: {
      accessTokenTTL: '15m',
      refreshTokenTTL: '7d',
      maxActiveSessions: 5,
      cookie: {
        enabled: true,
        // Browser setup is also enabled on public Cloudflare deployments and
        // must not implicitly widen their cookie transport. Only explicitly
        // local development or the self-hosted image gets the HTTP-loopback
        // exception.
        allowInsecureLocalhost: ALLOW_INSECURE_LOCALHOST_AUTH,
        name: 'hanji-refresh',
        legacyNames: [LEGACY_REFRESH_COOKIE_BASE_NAME_DELETE_ONLY],
        sameSite: 'strict',
      },
    },
    access: {
      // Anonymous sign-in is a dev/local bootstrap only (the frontend offers the
      // guest button solely when runtime-config's allowAnonymousBootstrap is
      // true). A direct POST to /api/auth/signin/anonymous would bypass that
      // cosmetic gate, so guard the endpoint per request here.
      //
      // The auth-access ctx exposes only { request, auth, ip } — no env binding —
      // and the config module's globalThis.process.env is empty in the workerd
      // runtime (at parse AND request time), so an env flag is unreadable here.
      // The request host/origin is attacker-controlled (a production request can
      // send `Host: 127.0.0.1`), but the connection source ip cannot be forged.
      // Gate on both the explicit config-time opt-in and a loopback ip: dev and
      // CI connect from 127.0.0.1/::1, while a release build omits the route.
      signInAnonymous: (_input, ctx) => {
        if (!ALLOW_DEV_GUEST_LOGIN) return false;
        const ip = (ctx as { ip?: unknown }).ip;
        if (typeof ip !== 'string') return false;
        const normalized = ip.trim().toLowerCase();
        const v4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
        return normalized === '::1' || v4 === '127.0.0.1' || v4.startsWith('127.');
      },
    },
    passwordPolicy: {
      minLength: 10,
      requireUppercase: true,
      requireLowercase: true,
      requireNumber: true,
      requireSpecial: true,
      checkLeaked: false,
    },
    mfa: {
      totp: true,
    },
    // Product decision 2026-07-10: email/password is the one product sign-in
    // path (plus optional OAuth via env). Magic link, email OTP, and passkeys
    // are disabled at the route level — the AuthGate UI had already hidden
    // them (2026-07-04), but a disabled config keeps the API surface closed
    // too. Re-enable deliberately when those flows return to the roadmap.
    magicLink: {
      enabled: false,
      autoCreate: true,
      tokenTTL: '15m',
    },
    emailOtp: {
      enabled: false,
      autoCreate: true,
    },
    passkeys: {
      enabled: false,
      rpName: 'Hanji',
      rpID: PASSKEY_RP_ID,
      origin: PASSKEY_ORIGINS.length ? PASSKEY_ORIGINS : AUTH_ORIGIN,
    },
    allowedRedirectUrls: [
      AUTH_ORIGIN,
      `${AUTH_ORIGIN}/auth/*`,
    ],
  },

  email: {
    provider: 'cloudflare',
    from: AUTH_EMAIL_FROM,
    apiKey: CLOUDFLARE_EMAIL_API_TOKEN,
    accountId: CLOUDFLARE_EMAIL_ACCOUNT_ID,
    binding: CLOUDFLARE_EMAIL_BINDING,
    appName: 'Hanji',
    defaultLocale: 'en',
    // EdgeBase's generic fragment-only fallbacks do not map to SPA routes.
    // Pin every emailed action to a real Hanji AuthGate screen while keeping
    // its bearer token in the fragment (outside HTTP requests/Referer).
    ...authEmailActionUrls(AUTH_ORIGIN),
    magicLinkUrl: `${AUTH_ORIGIN}/auth/magic-link#token={token}`,
    subjects: {
      magicLink: 'Sign in to {{appName}}',
      emailOtp: 'Your {{appName}} login code',
    },
  },

  // Sponsor balance pool for the login-screen banner (top-5 uniform
  // fifth-price burn; see backend/functions/sponsors.ts and
  // docs/sponsors.md "Decision (2026-07-10)").
  storage: {
    buckets: {
      files: {
        access: {
          // Direct bucket reads are always denied. File downloads must go through
          // file-mutation `signedUrl`, which runs assertUploadAccess (per-page/
          // workspace view-access check) and issues a capability token; a valid
          // signed token bypasses this rule at the runtime layer. Authorizing on
          // key shape alone would let any authenticated user read any workspace's
          // files by key and would survive access revocation.
          read: () => false,
          write: () => false,
          delete: () => false,
        },
      },
    },
  },

  rooms: {
    'page-presence': {
      maxPlayers: 80,
      stateTTL: 60 * 60 * 1000,
      rateLimit: {
        actions: 8,
        signals: 20,
        admin: 2,
      },
      access: {
        metadata: canUsePagePresenceRoom,
        join: canUsePagePresenceRoom,
        action: (auth, roomId, _actionType, _payload, ctx) =>
          canUsePagePresenceRoom(auth, roomId, ctx),
        signal: (auth, roomId, _event, _payload, ctx) =>
          canUsePagePresenceRoom(auth, roomId, ctx),
      },
    },
  },

  serviceKeys: {
    keys: [
      {
        kid: 'root',
        tier: 'root',
        scopes: ['*'],
        secretSource: 'dashboard',
        secretRef: 'SERVICE_KEY',
      },
    ],
  },

  rateLimiting,

  cors: {
    // The production SPA is served same-origin by this backend, and the MCP /
    // Notion-compat surfaces are server-to-server, so no public origin belongs
    // here. Browser CORS remains available for the separate Vite dev server;
    // its proxy keeps application requests same-origin in the browser.
    // AUTH_ORIGIN is included as an exact credentialed origin so an explicitly
    // configured production split works without coupling auth trust to custom
    // site routing. Same-origin browser requests are verified from the request
    // URL by EdgeBase and do not need an env allowlist entry.
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      AUTH_ORIGIN,
    ],
    credentials: true,
  },
});
