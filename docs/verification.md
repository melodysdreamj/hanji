# Verification and smoke catalog

Every check below runs against a local dev runtime (see
[development.md](development.md)) and prints PASS/FAIL without human visual
review. CI runs a gated subset on every push; run the scripts matching the
surface you touched.

## Split Vite/EdgeBase runs

Most UI smokes serve the built SPA from the EdgeBase runtime. If the EdgeBase
dev server was already running before your latest SPA build, either refresh it
(`npm --prefix backend run dev:refresh`) or point the check at the live Vite
app while keeping EdgeBase as the API by appending:

```bash
-- --url http://127.0.0.1:3000 --api-url http://127.0.0.1:8787
```

## Full suites

The namespace checks are dependency-free and can run before the live suites:

```bash
npm run verify:namespace
npm run test:namespace
npm --prefix web run build && npm run verify:namespace:generated
```

The source guard rejects old product names outside the exact centralized
read-compatibility declarations. The generated guard additionally checks
`web/dist` and permits only the known compatibility payload fragments used to
migrate existing browser data and delete old service-worker caches.

```bash
npm --prefix backend run verify:nonvisual
```

Runs the non-visual verification suite end to end: web build, web lint,
EdgeBase local-link/bundle checks, MCP checks, automatic local dev runtime
startup when needed, runtime/API smokes, workspace memberships, public
sharing, files, page presence, collaboration, notifications, Notion import
API/UI checks, and MCP live smoke. This intentionally skips human visual
review and browser screenshot inspection.

When the suite starts its own EdgeBase runtime, it configures a mock Notion
API base plus test-only stored-connection/OAuth secrets so Notion import
stored connection and OAuth paths are verified instead of skipped. If it
reuses an already-running runtime, start that runtime with
`HANJI_NOTION_API_BASE` and `HANJI_NOTION_IMPORT_SECRET` to get the
same strict checks.

To rerun only the Notion import API/UI portion against a separate Vite app
and an existing EdgeBase API:

```bash
HANJI_NOTION_API_BASE=http://127.0.0.1:9797/v1 npm --prefix backend run verify:nonvisual -- --only-notion-import --app-url http://127.0.0.1:3000 --url http://127.0.0.1:8787
```

```bash
npm --prefix backend run verify:deployment
```

Verifies the deployable EdgeBase app surfaces — see
[deployment.md](deployment.md#deployment-verification).

For a production Docker image behind repeatable NAS-like latency, bandwidth,
resource, and disconnect pressure, start the
[Synology-like Docker stress profile](development.md#synology-like-docker-stress-profile)
and run:

```bash
npm run verify:synology-sim
```

This check proves the impaired path and recovery, then uses the synthetic
master account to verify database creation, relations, rollups, related rows,
and authoritative computed output. Run the selected existing single-user
content smokes through the same master session with:

```bash
npm run verify:synology-existing
npm run verify:synology-existing -- relations properties
npm run verify:synology-existing -- outbox blocks
```

These cover the full relation/rollup API matrix, table property editing and
reload persistence, cache/outbox reload recovery, and representative block
creation/focus. Auth, provisioning, permissions, and other multi-user/account
lifecycle smokes still belong on the disposable isolated runtime; the
production appliance's anonymous route remains closed. The launcher restores
the synthetic master's prior language after each selected run, including a
failing run.

## Runtime and auth

| Command | What it checks |
| --- | --- |
| `verify:runtime` | Same-origin EdgeBase health, Hanji health function, direct SPA URLs, reload-safe fallback routes, and built frontend assets |
| `verify:auth-ui` | Password account creation, password sign-in, TOTP enrollment, and MFA challenge sign-in through the AuthGate UI |
| `verify:auth-route-ui` | Short landscape signup scrolling/touch targets plus safe malformed shared-link routing |
| `verify:service-worker-offline` | Fast boot-graph install, non-blocking full-graph warm, atomic offline marker, and a cache-only reload after network loss |
| `verify:dev-guest-login` | The visible guest shortcut and workspace bootstrap path on `localhost`, `127.0.0.1`, or `[::1]` (needs `VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true`) |
| `verify:security-settings-ui` | Settings Security surface: TOTP setup, recovery-code display, session review, TOTP disable |
| `verify:admin-provisioning` | Instance-admin account provisioning, forced first-sign-in password change, existing-account workspace member add, blind unknown-email handling, and membership persistence |
| `verify:page-email-share-ui` | Direct email page sharing through the SPA: account creation from `/p/:pageId`, Shared sidebar placement, read-only content, comment access |

All run as `npm --prefix backend run <command>`.

## Product API smokes

| Command | What it checks |
| --- | --- |
| `verify:permissions` | Multi-user permission path: temporary users plus a password account, private page denial, direct user and email page sharing, inherited child-page access, comment access, edit-role upgrades, block editing, database schema/row reads and row edit permissions, shared-page bootstrap without workspace membership, permission removal, page sharing audit events, and permanent delete cleanup for child pages, rows, blocks, comments, and database metadata |
| `verify:collaboration` | Persisted collaboration operations: multi-user operation write/replay permissions, comment-role denial, edit-role replay and append, stable cursor resume, initial Yjs CRDT update payload validation/replay, browser-generated Yjs block text updates carrying both a rich-text snapshot and real `Y.Text` state, concurrent Yjs text-update merge proof, editor replay batching, live room signal delivery, active-editor-safe browser apply with caret preservation, revocation, and permanent delete cleanup for collaboration logs |
| `verify:files` | File grant permissions: page/block-scoped upload grant preparation, file listing, workspace and organization file reporting, organization storage soft-limit denial, unshared denial, view-role metadata access without upload permission, edit-role upload preparation, deletion, cleanup dry-run, access revocation, and permanent page delete cleanup for attached upload grants |
| `verify:sharing` | Public Share to web snapshots: unauthenticated public share reads, disabled/missing share denial, shared subtree scoping, child page blocks, shared database metadata, and signed shared file URLs |
| `verify:notifications` | Notification generation and read state: access denial before sharing, direct page share notifications, role-change notifications, shared comment notifications, comment/reply person mentions with comment-anchor targets, update-panel activity sync, selected read-state updates, mark-all-read, and permanent page delete cleanup |
| `verify:presence` | Page presence room UI and live collaboration signal transport |

## Browser UI smokes

| Command | What it checks |
| --- | --- |
| `verify:updates-ui` | A generated reply mention notification in the Updates panel, Mentions filtering, comment-anchor navigation, and server read-state updates |
| `verify:search-ui` | Quick Find opening from the keyboard, page-title and body-block results, recent search recall/replay, and keyboard new-page creation |
| `verify:page-chrome-ui` | Page-title editing, emoji icon selection/removal, and page cover add/change/remove, including product API persistence |
| `verify:block-editor-ui` | Core editor interactions: plain typing, slash to-do insertion, Markdown heading/toggle/divider shortcuts, checkbox state, and toggle collapse |
| `verify:block-actions-ui` | Block action-menu duplicate/delete and keyboard nesting/outdenting, including DOM structure and product API persistence |
| `verify:block-drag-ui` | Drag-handle block reordering before and after other blocks, including DOM order and product API persistence |
| `verify:block-reorder-ui` | Block action-menu reordering (move up / move down), including DOM order and product API persistence |
| `verify:comments-ui` | Browser comment flow: page comment creation, block comment opening, replies, resolve/resolved tab movement, and comment anchor reveal |
| `verify:page-tree-ui` | Sidebar page tree keyboard expansion, focus movement, Home/End edge jumps, nested-page opening, page drag/drop movement, root/nested page reorder, Option/Alt page drag-copy, Private root page move/copy drops, editor block move/copy drops onto tree pages, private-root block drops that create new root pages, tree-menu rename/duplicate/trash persistence, view-only shared-page tree restrictions, and first-page creation in an empty workspace |
| `verify:workspace-switcher-ui` | Creating a second workspace from the sidebar menu, switching back, and product API cleanup |
| `verify:identity-lookup-ui` | Organization people lookup in the Share menu, comment/reply `@` mention composers, editor `@` mention picker, and database Person property picker |

## Database UI smokes

| Command | What it checks |
| --- | --- |
| `verify:database-property-edit` | Table-cell editing for title, rich text, checkbox, date, and select properties, including reload and product API persistence |
| `verify:database-property-drag` | Table column drag reordering, including view property-order persistence |
| `verify:database-property-menu` | Property menu view settings for wrapping and hiding columns |
| `verify:database-property-resize` | Column resize handles, including view property-width persistence |
| `verify:database-row-drag` | Row drag handles for before/after reordering |
| `verify:database-board-drag` | Board card drag: same-column reordering and cross-status moves |
| `verify:database-calendar-drag` | Calendar card drag for date rescheduling |
| `verify:database-timeline-drag` | Timeline bar move and end-resize, including start/end date persistence |
| `verify:database-view-tabs-drag` | View tab drag reordering, including view-position persistence |
| `verify:database-views-ui` | View tabs for table, board, list, gallery, calendar, and timeline, including direct `?v=` view URLs |
| `verify:database-imported-view-config` | Imported database view config for hidden properties and quick filters |
| `verify:database-row-peek` | Row opening: direct row preview URLs, side and center peek modes, row navigation, close behavior, and full-page opening |

## Notion import

To exercise Notion API import connection/job controls, dry-run review,
synthetic graph apply, relation/view remapping, row page body and row-linked
database preservation, structured job progress, copied file-reference
reporting, failed file-copy reporting, unresolved linked database/view
reporting, unresolved row/template relation and rich text mention reporting,
Notion rich text/link/mention preservation, Notion user/person reference
preservation, Notion formula/rollup computed fallback preservation, Notion
created/edited time preservation, Notion unique ID preservation, skipped
file-copy retry, discovery-truncation warnings, and UI/MCP conversion report
output without calling the external Notion API:

```bash
npm --prefix backend run verify:notion-import
```

For cursor-continuation discovery and full mock Notion API coverage, start
the EdgeBase runtime with a mockable Notion API base and run the smoke with
the same mock URL:

```bash
HANJI_NOTION_API_BASE=http://127.0.0.1:9797/v1 npm --prefix backend run dev
npm --prefix backend run verify:notion-import -- --mock-notion-api-base http://127.0.0.1:9797/v1
```

To exercise the Notion import web UI, including incomplete discovery report
surfacing from the same mock Notion API path:

```bash
npm --prefix backend run verify:notion-import-ui -- --mock-notion-api-base http://127.0.0.1:9797/v1
```

When `HANJI_NOTION_IMPORT_SECRET` is configured (see
[development.md](development.md#notion-import-secret)), the UI smoke can also
require the saved token connection path, connection-based discovery, and
revoke-time UI removal:

```bash
npm --prefix backend run verify:notion-import-ui -- --mock-notion-api-base http://127.0.0.1:9797/v1 --expect-stored-connection
```

## MCP live smoke

```bash
npm --prefix mcp run smoke:live
```

Connects to the local EdgeBase runtime with explicit per-client bearer
tokens, verifies MCP read-only/workspace/database allowlist narrowing,
verifies `mcp.client_action` audit events for mutating MCP calls, and
exercises workspace discovery, workspace list/create/delete, organization
policy update, workspace-scoped page create/list/search/delete, workspace
profile/existing-account member-add flow, page creation/content read, content
append/replace, page move/duplicate/trash/restore/delete, comments,
cross-user notification list/read state, Share to web, explicit page access,
file upload grant creation, file listing/reporting/deletion, database
creation, database view/property edits, row creation/update/query including
direct page/database access boundaries for non-workspace-member MCP users,
Notion import connection/job controls, and cleanup through MCP tools.
