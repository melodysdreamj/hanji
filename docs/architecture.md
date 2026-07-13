# Architecture

Three independent packages, each with its own `npm run dev`:

```
hanji/
├── backend/   EdgeBase BaaS — auth, database, storage, realtime (localhost:8787)
├── web/       Vite + React 19 static SPA front end (localhost:3000 in dev)
└── mcp/       Node stdio MCP server (talks to the backend's REST API)
```

The executable architecture contract lives in `backend/edgebase.config.ts`, the
three package manifests, and the verification commands in
[verification.md](verification.md).

## Data model

Defined in `backend/edgebase.config.ts`, block `app`:

```
organizations ─┬─ workspaces ─┬─ pages (tree; a page is a document OR a database container OR a database row)
                │              │     ├─ blocks         (a page's body content)
                │              │     ├─ db_properties  (columns, when the page is a database)
                │              │     └─ db_views       (saved views, when the page is a database)
                │              ├─ notion_import_connections / jobs / items / mappings
                │              └─ comments
                ├─ organization_members
                ├─ organization_groups
                ├─ organization_group_members
                ├─ organization_domains
                └─ organization_audit_events
```

A database **row is a page** (`parentType: "database"`) whose column values live
in `pages.properties` (JSON) — the same model Notion uses. `id`, `createdAt`,
`updatedAt` are injected automatically by EdgeBase.

## Auth and session security

The product sign-in surface is email + password (account creation and sign-in)
with TOTP MFA challenge completion and recovery codes; optional social sign-in
appears when OAuth provider credentials are configured (see
[development.md](development.md#social-sign-in-and-passkeys)). Magic links,
email one-time codes, and passkeys are currently disabled at the config level
(deferred on the roadmap). Settings includes an Account Security section for
authenticator-app enrollment, recovery-code display, session review, TOTP
disable, and self-service password change; admin-issued temporary passwords
force a password change on first sign-in. Accounts exist at the server level:
an instance administrator provisions them when public signup is closed, and a
workspace owner or administrator then adds an existing account by exact email
or user id. Unknown email addresses are handled as blind no-ops, so the member
form does not reveal whether an account exists.

Browser user sessions use EdgeBase's opt-in HttpOnly-cookie refresh transport.
On HTTPS the rotating credential is a host-only `__Host-` cookie with `Path=/`,
Strict SameSite, and Secure; plain-HTTP local development narrows the base-name
cookie to `/api/auth`. It is not returned to app JavaScript, stored in
localStorage, broadcast between tabs, or placed in OAuth callback URLs. Access
tokens remain short-lived and memory-only. Existing browser refresh tokens are
exchanged once and removed only after a successful cookie migration or a
definitive server rejection. Production should serve the SPA and API from the
same origin (the default packaged layout); a separate Vite development origin
is allowed only through the exact localhost CORS entries in
`backend/edgebase.config.ts`.

Known organization login attempts are written to the organization audit log.
The same audit log records public web sharing changes, page permission
grants/revokes, exports, and permanent page/database-row deletes where the
acting user belongs to a known organization workspace.

## Bounded import bodies

The synchronous import/export function reads JSON through a streaming byte
cap before parsing so an authenticated oversized request cannot exhaust a
128 MiB Worker isolate. The serialized request limit is 4 MiB plus 64 KiB of
envelope headroom. Native documents are additionally limited to 4 MiB and
150,000 JSON nodes. Markdown and CSV text have a 4 MiB raw UTF-8 secondary
ceiling, but JSON escaping counts toward the serialized request limit and can
therefore make the effective raw-text ceiling lower. Larger transfers must be
split until a resumable background import path is available.

## SSRF guarding

Caller-supplied URL fetches (Notion file import, URL previews, CIMD client
documents) are SSRF-guarded: blocked-range literal hosts are rejected, and
non-literal hostnames are resolved over DNS-over-HTTPS and rejected when any
returned address is loopback/private/link-local. Air-gapped or DoH-unreachable
self-hosted runtimes can tune this — see
[development.md](development.md#ssrf-guard-tuning).

## Master account

Every instance is provisioned from `HANJI_MASTER_EMAIL` /
`HANJI_MASTER_PASSWORD` on first boot; an instance started without them
refuses to initialize. Details: [master-account.md](master-account.md).
