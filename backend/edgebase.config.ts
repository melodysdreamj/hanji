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

const APP_ORIGIN =
  envValue('HANJI_APP_ORIGIN', 'EDGEBASE_APP_ORIGIN') ??
  'http://localhost:8787';

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
  originHostname(APP_ORIGIN);
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
const OAUTH_PROVIDERS = Object.fromEntries(
  OAUTH_PROVIDER_NAMES.map((provider) => {
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
const ALLOWED_OAUTH_PROVIDERS = Object.keys(OAUTH_PROVIDERS);
const ALLOW_DEV_GUEST_LOGIN = envFlag('HANJI_ALLOW_DEV_GUEST_LOGIN');
const BROWSER_SETUP_ENABLED = envFlag('HANJI_BROWSER_SETUP');
const TRUST_SELF_HOSTED_PROXY =
  envValue('HANJI_TRUST_SELF_HOSTED_PROXY') === undefined
    ? BROWSER_SETUP_ENABLED
    : envFlag('HANJI_TRUST_SELF_HOSTED_PROXY');

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
          },
          indexes: [{ fields: ['ownerId'] }],
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
            instanceAdminUserIds: { type: 'json' },
            masterUserId: { type: 'string' },
            masterEmail: { type: 'string' },
            updatedBy: { type: 'string' },
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
        // client forces a password change before the workspace UI unlocks.
        account_flags: {
          schema: {
            mustChangePassword: { type: 'boolean', default: false },
            reason: { type: 'string' },
            updatedBy: { type: 'string' },
          },
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
            createdBy: { type: 'string' },
            deactivatedAt: { type: 'datetime' },
            deactivatedBy: { type: 'string' },
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
            { fields: ['organizationId', 'organizationMemberId'] },
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
            { fields: ['workspaceId'] },
            { fields: ['actorId'] },
            { fields: ['action'] },
            { fields: ['occurredAt'] },
          ],
        },

        organization_enterprise_controls: {
          schema: {
            organizationId: {
              type: 'string',
              required: true,
              references: { table: 'organizations', onDelete: 'CASCADE' },
            },
            ssoConfig: { type: 'json' },
            scimConfig: { type: 'json' },
            auditPolicy: { type: 'json' },
            dataResidencyPolicy: { type: 'json' },
            dlpPolicy: { type: 'json' },
            legalPolicy: { type: 'json' },
            billingProfile: { type: 'json' },
            updatedBy: { type: 'string' },
          },
          indexes: [
            { fields: ['organizationId'] },
            { fields: ['updatedBy'] },
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
            { fields: ['status'] },
            { fields: ['createdBy'] },
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
            { fields: ['kind'] },
            { fields: ['status'] },
            { fields: ['renewalAt'] },
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
            kind: { type: 'string', default: 'page' }, // page | database

            title: { type: 'text' },
            icon: { type: 'string' }, // emoji char or image url/key
            iconType: { type: 'string', default: 'none' }, // none | emoji | image
            cover: { type: 'string' }, // image url/key
            coverPosition: { type: 'number', default: 50 }, // 0–100 vertical focal point
            font: { type: 'string', default: 'default' }, // default | serif | mono
            smallText: { type: 'boolean', default: false },
            fullWidth: { type: 'boolean', default: false },
            isLocked: { type: 'boolean', default: false },
            isPublic: { type: 'boolean', default: false },
            backlinksDisplay: { type: 'string', default: 'default' }, // default | expanded | off
            pageCommentsDisplay: { type: 'string', default: 'default' }, // default | expanded | off
            verifiedAt: { type: 'datetime' },
            verifiedBy: { type: 'string' },
            verificationExpiresAt: { type: 'datetime' },

            // Column values when this page is a row in a database: { [propertyId]: value }
            properties: { type: 'json' },

            isFavorite: { type: 'boolean', default: false },
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
            { fields: ['parentId', 'parentType'] },
          ],
          fts: ['title'],
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
          },
          indexes: [
            { fields: ['pageId'] },
            { fields: ['parentId'] },
            { fields: ['pageId', 'parentId'] },
          ],
          fts: ['plainText'],
        },

        // ─── Database columns ────────────────────────────────────────────
        db_properties: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            name: { type: 'string', required: true },
            description: { type: 'text' },
            // title | rich_text | number | select | multi_select | status | date |
            // person | checkbox | url | email | phone | files |
            // created_time | last_edited_time | created_by | last_edited_by | relation | rollup | formula
            type: { type: 'string', required: true },
            // Type-specific config: { options:[{id,name,color}], numberFormat, dateFormat, ... }
            config: { type: 'json' },
            position: { type: 'number', default: 0 },
          },
          indexes: [
            { fields: ['databaseId'] },
            { fields: ['type'] },
            { fields: ['databaseId', 'type'] },
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

        // ─── Database saved views ────────────────────────────────────────
        db_views: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            name: { type: 'string', default: 'Default view' },
            type: { type: 'string', required: true }, // table | board | list | gallery | calendar | timeline
            // { visibleProperties, propertyOrder, filters:[], sorts:[], groupBy, wrap, ... }
            config: { type: 'json' },
            position: { type: 'number', default: 0 },
          },
          indexes: [{ fields: ['databaseId'] }],
        },

        // ─── Database row/page templates ────────────────────────────────
        db_templates: {
          schema: {
            databaseId: {
              type: 'string',
              required: true,
              references: { table: 'pages', onDelete: 'CASCADE' },
            },
            name: { type: 'string', default: 'Untitled template' },
            icon: { type: 'string' },
            title: { type: 'text' },
            properties: { type: 'json' },
            blocks: { type: 'json' },
            isDefault: { type: 'boolean', default: false },
            position: { type: 'number', default: 0 },
          },
          indexes: [{ fields: ['databaseId'] }],
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
            workspaceAccess: { type: 'string', default: 'all_accessible' },
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
            // Copy-on-write pointer for crash-safe discovery snapshot replacement.
            activeItemGeneration: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['actorId'] },
            { fields: ['status'] },
            { fields: ['source'] },
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
            expiredAt: { type: 'datetime' },
            deletedAt: { type: 'datetime' },
            deletedBy: { type: 'string' },
            deletionPreviousStatus: { type: 'string' },
          },
          indexes: [
            { fields: ['workspaceId'] },
            { fields: ['key'] },
            { fields: ['url'] },
            { fields: ['pageId'] },
            { fields: ['blockId'] },
            { fields: ['databaseId'] },
            { fields: ['propertyId'] },
            { fields: ['templateId'] },
            { fields: ['createdBy'] },
            { fields: ['status'] },
            { fields: ['expiresAt'] },
            { fields: ['status', 'expiresAt'] },
            { fields: ['status', 'completedAt'] },
            { fields: ['status', 'updatedAt'] },
            { fields: ['status', 'createdAt'] },
            { fields: ['status', 'completedAt', 'updatedAt', 'createdAt'] },
          ],
        },

        // Serializes metadata/object/quota transitions with permanent content
        // deletion. Ordinary expired leases are replaceable; a lease carrying
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
  // Product data is functions-only. Release mode makes every raw DB resource
  // without an explicit access rule deny-by-default in local, packaged, and
  // deployed runtimes instead of silently bypassing authorization in dev.
  release: true,
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
        // Docker Desktop reaches a container through bridge/NAT even when the
        // browser address is plain-HTTP localhost. Keep the refresh credential
        // HttpOnly while allowing that one browser-local image path.
        allowInsecureLocalhost: BROWSER_SETUP_ENABLED,
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
      origin: PASSKEY_ORIGINS.length ? PASSKEY_ORIGINS : APP_ORIGIN,
    },
    allowedRedirectUrls: [
      APP_ORIGIN,
      `${APP_ORIGIN}/auth/*`,
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
    ...authEmailActionUrls(APP_ORIGIN),
    magicLinkUrl: `${APP_ORIGIN}/auth/magic-link#token={token}`,
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
    // APP_ORIGIN is included as an exact credentialed origin so a production
    // same-site split works without source edits; wildcard origins remain
    // intentionally rejected by EdgeBase.
    origin: [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://[::1]:3000',
      APP_ORIGIN,
    ],
    credentials: true,
  },
});
