# Hanji

<p align="center">
  <img src="assets/brand/hanji-hero.webp" alt="Hanji" width="360" />
</p>

An open-source Notion clone targeting the current Notion frontend, UX feel, and
non-AI product surface: pages, a block editor, databases, sharing, comments,
templates, import, trash, search, organization administration, and collaboration.
The product intentionally excludes Notion AI, Agents, research chat, and other
AI product features.

The backend follows an EdgeBase-first product-server shape, while the **Model
Context Protocol (MCP)** server stays in scope so external clients can read and
edit the workspace.

> The UI re-implements Notion's *interaction model and visual language* from
> scratch. It does not use Notion's source code, assets, or trademarks.

## Architecture

Three independent packages, each with its own `npm run dev`:

```
hanji/
├── backend/   EdgeBase BaaS — auth, database, storage, realtime (localhost:8787)
├── web/       Vite + React 19 static SPA front end (localhost:3000 in dev)
└── mcp/       Node stdio MCP server (talks to the backend's REST API)
```

The executable architecture contract lives in `backend/edgebase.config.ts`, the
three package manifests, and the verification commands documented below. Internal
development ledgers are intentionally kept outside the public product index.

**Data model** (`backend/edgebase.config.ts`, block `app`):

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

A database **row is a page** (`parentType: "database"`) whose column values live in
`pages.properties` (JSON) — the same model Notion uses. `id`, `createdAt`,
`updatedAt` are injected automatically by EdgeBase.

## Prerequisites

- Node.js ≥ 22.12
- npm

## Run it locally

Install the three packages first:

```bash
npm --prefix backend install
npm --prefix web install
npm --prefix mcp install
```

Then open three terminals.

The published `@edge-base/*` registry packages are used as installed. The
actual local server is opened by `backend` when `npm run dev` runs
`edgebase dev`.

**Optional — develop against a local EdgeBase source tree.** If you also work
on EdgeBase itself, place (or point to) a checkout and link it. The default
location is a sibling directory `../edgebase`; override with
`EDGEBASE_LOCAL_PATH` (or `EDGEBASE_ROOT`). Dependency installation replaces
local package links, so re-run the link script after any later install:

```bash
node scripts/link-local-edgebase.mjs
```

To verify whether the links point at a local EdgeBase checkout without
rewriting `node_modules`:

```bash
node scripts/link-local-edgebase.mjs --check
```

The backend also exposes the same check as:

```bash
npm --prefix backend run verify:local-edgebase
```

**1. Backend** (EdgeBase, port 8787, admin dashboard at `/admin`):

```bash
cd backend
npm run dev
```

> The `dev` script sets `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` so the local worker
> receives the JWT secrets from `.env.development`. Without it, auth fails with
> "JWT_USER_SECRET is not configured".

**2. Web app** (Vite SPA, port 3000):

```bash
cd web
npm run dev
```

Open http://localhost:3000. The current implemented sign-in surface supports
email one-time codes, magic links, password account creation, and password
sign-in, including TOTP MFA challenge completion for accounts that already have
MFA enrolled. It also handles OAuth callback sessions and exposes passkey sign-in
when the EdgeBase passkey config and browser WebAuthn support are available.
Settings & members also includes a Security section for authenticator-app
enrollment, recovery-code display, passkey add/remove, session review, and TOTP
disable. Workspace invitation links open a signed-in accept screen, so invited
users can create or use an account and join with the invited guest/member/admin
role from the SPA. Social sign-in buttons are shown from
`VITE_AUTH_OAUTH_PROVIDERS`, while the backend enables matching providers only
when their client ID/secret environment variables are present. The product auth target is broader
EdgeBase-backed account login: email flows, username/password, social login,
guest login, passkeys, and optional OTP/TOTP second factor all resolving to one
stable user identity. Code and link resends use the same short cooldown in the
SPA, and known organization login attempts are written to the organization audit
log. The same organization audit log also records public web sharing changes,
page permission grants/revokes, exports, and permanent page/database-row deletes
where the acting user belongs to a known organization workspace.

Browser user sessions use EdgeBase's opt-in HttpOnly-cookie refresh transport.
The rotating refresh credential is host-only, scoped to `/api/auth`, Strict
SameSite, and Secure on HTTPS; it is not returned to app JavaScript, stored in
localStorage, broadcast between tabs, or placed in OAuth callback URLs. Access
tokens remain short-lived and memory-only. Existing browser refresh tokens are
exchanged once and removed only after a successful cookie migration or a
definitive server rejection. Production should serve the SPA and API from the
same origin (the default packaged layout); a separate Vite development origin
is allowed only through the exact localhost CORS entries in
`backend/edgebase.config.ts`.

Hanji uses Cloudflare Email Service as its first-party mail path. For local,
Docker, or packaged runtimes, configure REST delivery:

```bash
NOTIONLIKE_AUTH_EMAIL_FROM=noreply@example.com
NOTIONLIKE_CLOUDFLARE_EMAIL_ACCOUNT_ID=...
NOTIONLIKE_CLOUDFLARE_EMAIL_API_TOKEN=...
```

For hosted Cloudflare Workers, configure the Workers `send_email` binding and
set the binding name if it is not `EMAIL`:

```bash
NOTIONLIKE_CLOUDFLARE_EMAIL_BINDING=EMAIL
```

Anonymous auth is kept only as an explicit local-origin bootstrap escape hatch
while the app is under development. The frontend flag lets the button exist in
a local build, and the EdgeBase dev runtime must also opt in through
`NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN=true`:

```bash
VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true
```

Caller-supplied URL fetches (Notion file import, URL previews, CIMD client
documents) are SSRF-guarded: blocked-range literal hosts are rejected, and
non-literal hostnames are resolved over DNS-over-HTTPS and rejected when any
returned address is loopback/private/link-local. Air-gapped or DoH-unreachable
self-hosted runtimes can tune this:

```bash
# Skip the DNS resolution step (literal-host checks still apply).
NOTIONLIKE_SSRF_DNS_CHECK=off
# Use a different DNS-over-HTTPS resolver (default: https://cloudflare-dns.com/dns-query).
NOTIONLIKE_SSRF_DOH_URL=https://dns.google/resolve
```

For packaged/runtime serving, build the SPA first:

```bash
cd web
npm run build
```

`backend/edgebase.config.ts` points EdgeBase at `../web/dist` with
`spaFallback: true`, so an EdgeBase runtime can serve both API traffic and
Notion-style frontend URLs from the same origin.

With the backend dev runtime still running, verify that the same origin serves
EdgeBase health, the Hanji health function, direct SPA URLs, reload-safe
fallback routes, and built frontend assets without opening a browser:

```bash
npm --prefix backend run verify:runtime
```

If that check reports a stale served SPA bundle, refresh the local EdgeBase dev
runtime and rerun the runtime smoke. The refresh command checks whether tracked
frontend inputs are newer than `web/dist/index.html` and rebuilds `web/dist`
first when needed:

```bash
npm --prefix backend run dev:refresh
```

To exercise password account creation, password sign-in, TOTP enrollment, and
MFA challenge sign-in through the AuthGate UI against the local EdgeBase
runtime, run:

```bash
npm --prefix backend run verify:auth-ui
```

When `VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true` is enabled for local development,
verify the visible guest shortcut and workspace bootstrap path on
`localhost`, `127.0.0.1`, or `[::1]` with:

```bash
npm --prefix backend run verify:dev-guest-login
```

If the EdgeBase dev server was already running before the latest SPA build,
run `npm --prefix backend run dev:refresh`, or point the check at the Vite app
while keeping EdgeBase as the API:

```bash
npm --prefix backend run verify:auth-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

To exercise workspace invitation onboarding through the SPA, including creating
the invited account from an invite URL and accepting a guest workspace role, run:

```bash
npm --prefix backend run verify:workspace-invite-ui
```

For a split Vite/EdgeBase setup:

```bash
npm --prefix backend run verify:workspace-invite-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

To exercise direct email page sharing through the SPA, including account
creation from `/p/:pageId`, Shared sidebar placement, read-only content, and
comment access, run:

```bash
npm --prefix backend run verify:page-email-share-ui
```

For a split Vite/EdgeBase setup:

```bash
npm --prefix backend run verify:page-email-share-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

Passkeys are enabled by `backend/edgebase.config.ts`. For hosted or split local
frontends, set `NOTIONLIKE_PASSKEY_RP_ID` and `NOTIONLIKE_PASSKEY_ORIGINS` so the
WebAuthn relying-party ID and allowed origins match the URL users actually open.
Social login is opt-in: set `NOTIONLIKE_AUTH_OAUTH_PROVIDERS` or
`EDGEBASE_AUTH_ALLOWED_OAUTH_PROVIDERS`, provide matching
`NOTIONLIKE_OAUTH_<PROVIDER>_CLIENT_ID` / `NOTIONLIKE_OAUTH_<PROVIDER>_CLIENT_SECRET`
values, and mirror the visible buttons with `VITE_AUTH_OAUTH_PROVIDERS`.

To exercise the Settings Security surface for TOTP setup, recovery-code display,
session review, and TOTP disable, run:

```bash
npm --prefix backend run verify:security-settings-ui
```

If you are serving the live Vite app separately, pass the same split URLs:

```bash
npm --prefix backend run verify:security-settings-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

Passkey add/remove and passkey sign-in require a real browser authenticator and
matching WebAuthn origin/RP settings, so they are wired into the product UI but
are not covered by the current non-visual smoke scripts.

To exercise Notion API import connection/job controls, dry-run review, synthetic
graph apply, relation/view remapping, row page body and row-linked database preservation, structured job progress, copied
file-reference reporting, failed file-copy reporting, unresolved linked database/view reporting, unresolved row/template relation and rich text mention reporting, Notion rich text/link/mention preservation, Notion user/person reference preservation, Notion formula/rollup computed fallback preservation, Notion created/edited time preservation, Notion unique ID preservation, skipped file-copy retry, discovery-truncation warnings, and UI/MCP conversion report output
without calling the external Notion API, run:

```bash
npm --prefix backend run verify:notion-import
```

For cursor-continuation discovery, database-container, row page body, row-linked
database, Notion rich text/link/mention preservation, Notion user/person property preservation, unresolved row/template relation and rich text mention reporting, Notion formula/rollup computed fallback preservation, Notion created/edited time preservation, Notion unique ID preservation, discovery-truncation report warnings, and mock Notion API coverage without calling the external Notion API,
start the EdgeBase runtime with a mockable Notion API base and run the smoke with
the same mock URL:

```bash
NOTIONLIKE_NOTION_API_BASE=http://127.0.0.1:9797/v1 npm --prefix backend run dev
npm --prefix backend run verify:notion-import -- --mock-notion-api-base http://127.0.0.1:9797/v1
```

To exercise the Notion import web UI without screenshots, including incomplete
discovery report surfacing from the same mock Notion API path, run:

```bash
NOTIONLIKE_NOTION_API_BASE=http://127.0.0.1:9797/v1 npm --prefix backend run dev
npm --prefix backend run verify:notion-import-ui -- --mock-notion-api-base http://127.0.0.1:9797/v1
# Or point a fresh Vite frontend at the still-running EdgeBase API:
npm --prefix backend run verify:notion-import-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787 --mock-notion-api-base http://127.0.0.1:9797/v1
```

Stored Notion import connections encrypt credentials with a server-side secret
and never expose raw tokens through web or MCP responses. Configure this before
creating saved connections:

```bash
NOTIONLIKE_NOTION_IMPORT_SECRET=replace-with-a-long-random-secret
```

When that secret is configured, the Notion import UI smoke can require the saved
token connection path, connection-based discovery, and revoke-time UI removal as
part of the same browser flow:

```bash
npm --prefix backend run verify:notion-import-ui -- --mock-notion-api-base http://127.0.0.1:9797/v1 --expect-stored-connection
```

To run the non-visual verification suite end to end, including web build,
web lint, EdgeBase local-link/bundle checks, MCP checks, automatic local dev
runtime startup when needed, runtime/API smokes, workspace memberships, public
sharing, files, page presence, collaboration, notifications, Notion import API/UI
checks, and MCP live smoke, run:

```bash
npm --prefix backend run verify:nonvisual
```

This intentionally skips human visual review and browser screenshot inspection.
When the suite starts its own EdgeBase runtime, it configures a mock Notion API
base plus test-only stored-connection/OAuth secrets so Notion import stored
connection and OAuth paths are verified instead of skipped. If it reuses an
already-running runtime, start that runtime with `NOTIONLIKE_NOTION_API_BASE` and
`NOTIONLIKE_NOTION_IMPORT_SECRET` to get the same strict checks.

To rerun only the Notion import API/UI portion against a separate Vite app and
an existing EdgeBase API, use split URLs:

```bash
NOTIONLIKE_NOTION_API_BASE=http://127.0.0.1:9797/v1 npm --prefix backend run verify:nonvisual -- --only-notion-import --app-url http://127.0.0.1:3000 --url http://127.0.0.1:8787
```

To exercise the page presence room UI and live collaboration signal transport,
run:

```bash
npm --prefix backend run verify:presence
```

If the EdgeBase dev server was already running before the latest SPA build,
run it against the live Vite app while keeping EdgeBase as the API:

```bash
npm --prefix backend run verify:presence -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

To exercise the multi-user permission path through product APIs, run:

```bash
npm --prefix backend run verify:permissions
```

That creates temporary users plus a password account, checks private page
denial, direct user and email page sharing, inherited child-page access, comment
access, edit-role upgrades, block editing, database schema/row reads and row
edit permissions, shared-page bootstrap without workspace membership, permission
removal, page sharing audit events, and permanent delete cleanup for child
pages, rows, blocks, comments, and database metadata.

To exercise the persisted collaboration operation path through product APIs,
run:

```bash
npm --prefix backend run verify:collaboration
```

That checks multi-user operation write/replay permissions, comment-role denial,
edit-role replay and append, stable cursor resume, initial Yjs CRDT update
payload validation/replay through the same product API, browser-generated Yjs
block text updates carrying both a rich-text snapshot and real `Y.Text` state,
concurrent Yjs text-update merge proof for two independent inserts on the same
block, editor replay batching for contiguous same-block CRDT updates, live room
signal delivery, active-editor-safe browser apply with caret preservation, and
browser apply plumbing,
revocation, and permanent delete cleanup for collaboration logs.

To exercise file grant permissions through product APIs, run:

```bash
npm --prefix backend run verify:files
```

That checks page/block-scoped upload grant preparation, file listing, workspace
and organization file reporting, organization storage soft-limit denial,
unshared denial, view-role metadata access without upload permission, edit-role
upload preparation, deletion, cleanup dry-run, access revocation, and permanent
page delete cleanup for attached upload grants.

To exercise public Share to web snapshots through product APIs, run:

```bash
npm --prefix backend run verify:sharing
```

That checks unauthenticated public share reads, disabled/missing share denial,
shared subtree scoping, child page blocks, shared database metadata, and signed
shared file URLs for page file blocks and database row file properties.

To exercise notification generation and read state through product APIs, run:

```bash
npm --prefix backend run verify:notifications
```

That checks workspace notification access denial before sharing, direct page
share notifications, page permission role-change notifications, shared comment
notifications, comment/reply person mentions with comment-anchor targets,
update-panel activity sync, selected read-state updates, mark-all-read, and
permanent page delete cleanup.

To check that persisted notifications appear in the Updates panel without a
manual visual pass, run:

```bash
npm --prefix backend run verify:updates-ui
```

That checks a generated reply mention notification in the Updates panel,
Mentions filtering, comment-anchor navigation, and server read-state updates.

If the EdgeBase dev server was already running before the latest SPA change,
run it against the live Vite app while keeping EdgeBase as the API:

```bash
npm --prefix backend run verify:updates-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

```bash
npm --prefix backend run verify:search-ui
```

That checks Quick Find opening from the keyboard, page-title and body-block
results, recent search recall/replay, and keyboard new-page creation without
screenshots.

```bash
npm --prefix backend run verify:page-chrome-ui
```

That checks page-title editing, emoji icon selection/removal, and page cover
add/change/remove, including product API persistence without screenshots.

```bash
npm --prefix backend run verify:block-editor-ui
```

That checks core browser editor interactions for plain typing, slash to-do
insertion, Markdown heading/toggle/divider shortcuts, checkbox state, and
toggle collapse, including product API persistence without screenshots.

```bash
npm --prefix backend run verify:block-actions-ui
```

That checks block action-menu duplicate/delete and keyboard nesting/outdenting,
including DOM structure and product API persistence without screenshots.

```bash
npm --prefix backend run verify:block-drag-ui
```

That checks drag-handle block reordering by dragging a block before and after
other blocks, including DOM order and product API persistence without
screenshots.

```bash
npm --prefix backend run verify:block-reorder-ui
```

That checks block action-menu reordering by moving a block up and back down,
including DOM order and product API persistence without screenshots.

```bash
npm --prefix backend run verify:comments-ui
```

That checks the browser comment flow for page comment creation, block comment
opening, replies, resolve/resolved tab movement, and comment anchor reveal.

```bash
npm --prefix backend run verify:page-tree-ui
```

That checks sidebar page tree keyboard expansion, focus movement, Home/End edge
jumps, nested-page opening, page drag/drop movement, root/nested page reorder,
Option/Alt page drag-copy behavior, Private root page move/copy drops, editor
block move/copy drops onto tree pages, private-root block drops that create new root pages, tree-menu
rename/duplicate/trash persistence, view-only shared-page tree restrictions, and
first-page creation in an empty workspace without screenshots.

```bash
npm --prefix backend run verify:workspace-switcher-ui
```

That checks creating a second workspace from the sidebar menu, switching back to
the original workspace, and product API cleanup without screenshots.

```bash
npm --prefix backend run verify:database-property-edit
```

That checks browser table-cell editing for title, rich text, checkbox, date, and
select properties, including reload and product API persistence.

```bash
npm --prefix backend run verify:identity-lookup-ui
```

That checks organization people lookup in the Share menu, comment/reply `@`
mention composers, editor `@` mention picker, and database Person property
picker through browser DOM and product API persistence assertions, without
screenshots.

For a split Vite/EdgeBase setup:

```bash
npm --prefix backend run verify:identity-lookup-ui -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

```bash
npm --prefix backend run verify:database-property-drag
```

That checks browser table column drag reordering, including reload and product
API view property-order persistence.

```bash
npm --prefix backend run verify:database-property-menu
```

That checks browser table property menu view settings for wrapping and hiding
columns, including reload and product API persistence.

```bash
npm --prefix backend run verify:database-property-resize
```

That checks browser table column resize handles, including reload and product
API view property-width persistence.

```bash
npm --prefix backend run verify:database-row-drag
```

That checks browser database row drag handles for before/after reordering,
including reload and product API persistence.

```bash
npm --prefix backend run verify:database-board-drag
```

That checks browser board card drag behavior for same-column reordering and
cross-status moves, including reload and product API persistence.

```bash
npm --prefix backend run verify:database-calendar-drag
```

That checks browser calendar card drag behavior for date rescheduling, including
reload and product API persistence.

```bash
npm --prefix backend run verify:database-timeline-drag
```

That checks browser timeline bar move and end-resize behavior, including reload
and product API start/end date persistence.

```bash
npm --prefix backend run verify:database-view-tabs-drag
```

That checks browser database view tab drag reordering, including reload and
product API view-position persistence.

```bash
npm --prefix backend run verify:database-views-ui
```

That checks browser database view tabs for table, board, list, gallery,
calendar, and timeline, including direct `?v=` view URLs.

```bash
npm --prefix backend run verify:database-imported-view-config
```

That checks imported database view config for hidden properties and quick
filters through the browser UI and product API without screenshots.

If the EdgeBase dev server was already running before the latest SPA change,
run it against the live Vite app while keeping EdgeBase as the API:

```bash
npm --prefix backend run verify:database-imported-view-config -- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

```bash
npm --prefix backend run verify:database-row-peek
```

That checks database row opening from the browser, including direct row preview
URLs, side and center peek modes, row navigation, close behavior, and full-page
opening.

**3. MCP server** (optional, for AI agents):

```bash
cd mcp
NOTIONLIKE_MCP_AUTH_MODE=token NOTIONLIKE_MCP_ACCESS_TOKEN=... \
  claude mcp add notionlike -- node "$(pwd)/src/index.mjs"
```

Optional MCP policy environment variables can narrow a client to read-only mode
or specific workspace/page/database ids:
`NOTIONLIKE_MCP_READ_ONLY=true`,
`NOTIONLIKE_MCP_ALLOWED_WORKSPACE_IDS=...`,
`NOTIONLIKE_MCP_ALLOWED_PAGE_IDS=...`, and
`NOTIONLIKE_MCP_ALLOWED_DATABASE_IDS=...`.

See [`mcp/README.md`](mcp/README.md) for the available tools.
The live MCP smoke (`npm --prefix mcp run smoke:live`) connects to the local
EdgeBase runtime with explicit per-client bearer tokens, verifies local MCP
read-only/workspace/database allowlist narrowing, verifies `mcp.client_action` audit events for mutating MCP calls, and exercises workspace discovery, workspace list/create/delete,
organization policy update, workspace-scoped page create/list/search/delete, workspace profile/member
invitation flow, page creation/content read, content append/replace, page
move/duplicate/trash/restore/delete, comments, cross-user notification list/read
state, Share to web, explicit page access, file upload grant creation, file
listing/reporting/deletion, database creation, database view/property edits, row
creation/update/query including direct page view/comment/edit access boundaries
and direct database view/edit/full-access boundaries for non-workspace-member
MCP users, Notion import connection/job controls, and cleanup
through MCP tools.

## Deployment Verification

To verify the deployable EdgeBase app surfaces without human visual review, run:

```bash
npm --prefix backend run verify:deployment
```

That rebuilds the SPA, verifies the local EdgeBase package links, checks the
EdgeBase app bundle, a temporary portable directory pack runtime, hosted deploy
dry-run bundle, Docker image/context, and a temporary Docker runtime with SPA
fallback routes for `/`, `/settings`, `/trash`, `/p/:id`, `/database/:id`,
`/workspace/:slug`, and `/share/:id`. If Docker is unavailable, use
`node scripts/deployment-verify.mjs --skip-docker` to verify the pack runtime
and hosted deploy dry-run output only.

## Features

**Pages & editor**
- Nested page tree, favorites, trash (restore / delete forever)
- Page icon (emoji picker), cover, page lock, backlinks, comments, and updates
- From-scratch block editor: text, H1–H3, bulleted / numbered / to-do / toggle
  lists, quote, callout, divider, code, equations, simple tables, synced blocks,
  buttons, breadcrumbs, table of contents, columns, and media/file embeds
- Slash (`/`) command menu, Markdown shortcuts (`#`, `-`, `1.`, `[]`, `>`, `` ``` ``, `---`)
- Inline marks — bold / italic / underline / strikethrough / inline code / links
  (selection toolbar + ⌘B / ⌘I / ⌘U / ⌘E / ⌘K)
- Block actions: turn-into, duplicate, delete, nest/outdent, drag/reorder, undo/redo
- Full-text search (FTS5, CJK-aware) over titles and block text

**Databases**
- Property types: title, text, number, select, multi-select, status, date,
  checkbox, URL, email, phone, person, files, relation, rollup, formula,
  unique ID, and created/last-edited time/by
- Table, Board (kanban), List, Gallery, Calendar, and Timeline views;
  view tabs; filters, sorts, grouping, row height/wrap and display options
- Add columns and rows inline; every row opens as its own page
- Database row templates with default template support, template editing,
  duplication, deletion, and MCP parity

**MCP**
- List organizations/accounts through the product API
- Read organization directories with filterable recent admin-visible audit events
  and profile summaries for each person's workspace memberships/pending invites,
  create/update/delete reusable groups and add/remove active organization members from
  groups, grant page access to groups, add/verify/remove organization domains, and transfer organization ownership or
  deactivate/reactivate/remove organization members through the product API.
  Organization removal also clears organization workspace memberships, matching
  pending invitations, group memberships, and direct page permissions while
  reassigning page/block/comment/file ownership metadata to a selected active
  non-guest organization member. Workspace invitation and
  workspace member lifecycle changes, public web sharing changes, page
  permission grants/revokes, exports, and permanent page/database-row deletes are
  also recorded as filterable organization audit events. Verified domains also gate internal member/admin invitations
  while external emails stay on the guest path. Domain signup policy can require
  member/admin profile and join paths to stay on verified organization domains.
- Update organization workspace creation, domain signup, storage limit, and sharing policy,
  including public web sharing, external email sharing, guest access, file
  downloads, and full-access grants
- List/create/delete empty workspaces through the product API
- Invite workspace members by email through product APIs with delivery status
  recorded from the configured EdgeBase email provider, and accept invite links
  through the SPA so invited accounts can join with the granted workspace role
- Transfer workspace ownership through the product API while keeping the
  previous owner as an admin
- Read/search/create/move/lock pages, append or replace Markdown content, and
  operate on trash recursively
- List/add/resolve comments
- Describe/query databases, manage rows/properties, and manage database templates

**Responsive**
- Desktop: collapsible 240px sidebar. Mobile (≤767px): sidebar becomes a slide-in
  overlay drawer (hamburger + backdrop, auto-closes on navigation), content goes
  full-width, matching Notion's mobile UX.

**Backend**
- Anonymous + email auth, realtime subscriptions, R2-style file storage, all local
  via Miniflare (`workerd`)

## Status & roadmap

Active development build with a broad Notion-like editing/database surface. It
is not represented as production-ready until a hosted deployment has passed the
deployment and runtime verification gates with production secrets configured.
Known follow-ups:
- Hardening: migration/versioning story, more automated tests, and larger-workspace
  performance passes
- Collaboration: conflict handling, permissions/sharing, and multi-workspace UX
- Product depth: import/export, richer file handling, mobile polish, and deeper
  database formula/rollup parity

## License

MIT.
