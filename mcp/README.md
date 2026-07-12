# Hanji MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI
agents read and edit your local Hanji workspace.

It talks to the local EdgeBase backend (`http://localhost:8787` by default) over
its REST API, so the **backend must be running** (`npm run dev` in `backend/`).

## Authentication

MCP traffic stays on the Hanji product API and authenticates with a normal
EdgeBase bearer token when one is provided:

```bash
HANJI_MCP_ACCESS_TOKEN=...
```

Accepted token environment variables are checked in this order:
`HANJI_MCP_ACCESS_TOKEN`, `HANJI_EDGEBASE_ACCESS_TOKEN`, then
`EDGEBASE_ACCESS_TOKEN`. Values may be raw tokens or `Bearer ...` strings.

Set `HANJI_MCP_AUTH_MODE=token` to require a provided token and fail fast
when one is missing. Local development can still fall back to anonymous
bootstrap when no token is configured; disable that fallback with:

```bash
HANJI_MCP_ALLOW_ANONYMOUS=false
```

## Access policy

The authenticated EdgeBase user or service principal remains the real security
boundary. Optional MCP policy variables can only narrow what this MCP process is
allowed to do:

```bash
HANJI_MCP_READ_ONLY=true
HANJI_MCP_ALLOWED_WORKSPACE_IDS=workspace-a,workspace-b
HANJI_MCP_ALLOWED_PAGE_IDS=page-a,page-b
HANJI_MCP_ALLOWED_DATABASE_IDS=database-a,database-b
```

For a durable scoped-consent/provisioning artifact, point the MCP process at a
JSON policy file:

```bash
HANJI_MCP_POLICY_FILE=/secure/hanji-mcp-policy.json
```

```json
{
  "readOnly": true,
  "allowedWorkspaceIds": ["workspace-a"],
  "allowedPageIds": ["page-a"],
  "allowedDatabaseIds": ["database-a"],
  "scopes": ["pages", "comments", "sharing", "files"],
  "clientId": "analyst-readonly",
  "clientName": "Analyst Read-only MCP",
  "subjectType": "service_principal",
  "subjectId": "svc-analyst-readonly",
  "issuer": "hanji-admin",
  "audience": "hanji-edgebase",
  "transport": "stdio",
  "provisioningId": "consent-2026-07-04-analyst",
  "expiresAt": "2026-08-01T00:00:00.000Z"
}
```

`HANJI_MCP_CONSENT_FILE` is accepted as an alias. Environment allowlists
still work as local overrides, but when both a policy file and env allowlist are
present, the effective policy is the narrower intersection. Env flags can make a
client read-only, but cannot make a read-only policy file writable.
Policy files may include `notBefore`/`not_before` and `expiresAt`/`expires_at`
ISO timestamps; an MCP process rejects a policy file before its validity window
or after it expires.
Use `HANJI_MCP_SCOPES=pages,comments` to narrow scopes from the environment
instead of a file. Supported scope names are `pages`, `databases`, `comments`,
`sharing`, `files`, `notifications`, `import_export`, `notion_import`,
`workspace_admin`, `organization`, and `organization_admin`. Omit `scopes` to
leave feature-level scope unrestricted and rely on the authenticated user's
product permissions plus any allowlists.

`HANJI_MCP_ALLOW_WRITES=false` is also accepted as a read-only alias. Use
`get_mcp_access_policy` from an MCP client to inspect the active local policy.
Successful mutating MCP-backed product API calls also write a
`mcp.client_action` organization audit event when the affected workspace can be
resolved.

For deployed or multi-user stdio setups, provision one MCP process per user or
service principal with:

- an EdgeBase bearer token in `HANJI_MCP_ACCESS_TOKEN`
- `HANJI_MCP_AUTH_MODE=token`
- `HANJI_MCP_ALLOW_ANONYMOUS=false`
- a policy file containing the allowlists/scopes and durable subject metadata
  (`subjectType`, `subjectId`, `issuer`, `audience`, `transport`,
  `provisioningId`)

`subjectType` accepts `user`, `service_principal`, `integration`, or `bot`.
The equivalent environment variables are `HANJI_MCP_SUBJECT_TYPE`,
`HANJI_MCP_SUBJECT_ID` or `HANJI_MCP_SERVICE_PRINCIPAL_ID`,
`HANJI_MCP_POLICY_ISSUER`, `HANJI_MCP_POLICY_AUDIENCE`,
`HANJI_MCP_TRANSPORT`, and `HANJI_MCP_PROVISIONING_ID`. The stdio
transport follows current MCP authorization guidance by reading credentials
from the environment. Hanji also ships a hosted Streamable HTTP-compatible
JSON-RPC transport backed by OAuth authorization-code + PKCE, protected-resource
metadata, audience validation, scoped grants, and no bearer-token passthrough.
The hosted surface is intentionally incremental: supported read/query,
comment, duplicate/move, and database-view operations are live, while primary
Notion-compatible create/update page and database writes fail closed until they
delegate to Hanji's canonical stored-file lifecycle.

## Tools

| Tool | What it does |
| --- | --- |
| `get_workspace` | Workspace name/id and page count (orientation) |
| `get_mcp_access_policy` | Show the local read-only and allowlist policy applied to this MCP process |
| `list_workspaces` | List workspaces accessible to the current MCP user |
| `list_organizations` | List organizations/accounts accessible to the current MCP user |
| `get_organization_directory` | List organization members, profile membership summaries, workspaces, domains, and optionally filtered recent admin-visible audit events, including workspace invitation/member lifecycle events |
| `search_organization_people` | Search organization people profiles by name, email, user id, role, or workspace membership |
| `update_organization_settings` | Update organization workspace creation, domain signup, storage limit, and sharing policy through product APIs |
| `transfer_organization_owner` | Transfer organization ownership to an active organization member |
| `deactivate_organization_member` | Deactivate an organization member through product APIs |
| `reactivate_organization_member` | Reactivate an organization member through product APIs |
| `remove_organization_member` | Remove an organization member, reassign page/block/comment/file ownership metadata, and clear organization workspace memberships, pending invitations, group memberships, and direct page permissions through product APIs |
| `create_organization_group` | Create a reusable organization group/team through product APIs |
| `update_organization_group` | Rename or update a reusable organization group/team through product APIs |
| `delete_organization_group` | Delete a reusable organization group/team through product APIs |
| `add_organization_group_member` | Add an active organization member to a reusable organization group/team |
| `remove_organization_group_member` | Remove a member from a reusable organization group/team |
| `add_organization_domain` | Add a pending organization email domain through product APIs |
| `verify_organization_domain` | Mark an organization domain verified through product APIs |
| `remove_organization_domain` | Remove an organization email domain through product APIs |
| `create_workspace` | Create a new owner workspace without switching the current MCP workspace |
| `delete_workspace` | Delete an owner-only empty workspace |
| `list_workspace_members` | List workspace members and pending invitations, including email delivery status |
| `invite_workspace_member` | Invite an email address with product email delivery status, or add/update a known user |
| `accept_workspace_invitation` | Accept a pending workspace invitation by token or id |
| `update_my_workspace_profile` | Update the current user's workspace name/email profile |
| `revoke_workspace_invitation` | Revoke a pending workspace email invitation |
| `transfer_workspace_owner` | Transfer workspace ownership to another existing member |
| `update_workspace_member_role` | Change a workspace member role |
| `remove_workspace_member` | Remove a user from the workspace |
| `search_pages` | Full-text search page titles, optionally scoped to a workspace |
| `search_blocks` | Full-text search visible page body blocks, optionally scoped to a workspace |
| `list_pages` | List top-level pages, or a page's sub-pages, optionally scoped to a workspace |
| `get_page` | Read a page's metadata and content as Markdown |
| `create_page` | Create a page in the current or specified workspace (optional parent, emoji/image icon, cover, layout, Markdown body) |
| `list_page_templates` | List built-in local page templates from the web sidebar |
| `create_page_from_template` | Create a top-level page from a built-in local page template in the current or specified workspace |
| `duplicate_page` | Duplicate a page subtree, including child pages, blocks, databases, views, templates, and rows |
| `update_page` | Rename / change emoji/image icon, cover, font, layout, page display settings, or lock state |
| `set_page_lock` | Lock or unlock a page |
| `set_page_favorite` | Add or remove a page from Favorites |
| `set_page_verification` | Verify a page or remove verification metadata |
| `set_page_web_sharing` | Enable or disable the local Share to web flag, with optional public-link expiration |
| `list_page_access` | List a page's Share to web state, public-link expiration, and explicit permissions |
| `get_shared_page` | Read a public shared page snapshot by `/share/:shareId` |
| `grant_page_access` | Grant explicit page access to a user, email, organization group, or integration |
| `update_page_access` | Change an explicit page permission role |
| `revoke_page_access` | Remove an explicit page permission |
| `add_content` | Append Markdown content to a page as blocks |
| `replace_page_content` | Replace a page body with Markdown content |
| `move_page` | Move a page to root, under another page, or into a database |
| `list_comments` | List page and block comments |
| `add_comment` | Add a page, block, or reply comment |
| `resolve_comment` | Resolve or reopen a comment thread |
| `list_trash` | List top-level pages currently in trash |
| `trash_page` | Move a page subtree to the trash |
| `restore_page` | Restore a trashed page subtree |
| `delete_page_forever` | Permanently delete a page subtree |
| `list_databases` | List local databases and row counts |
| `create_database` | Create a database through the backend product API with default or custom properties, optional starter rows, and an initial view |
| `describe_database` | Read database properties, views, and row count |
| `create_database_view` | Create a database view with filters, grouping, date axes, display, and sort settings |
| `update_database_view` | Update a database view's name, type, filters, display, grouping, date axes, and sorts |
| `delete_database_view` | Delete a saved database view while protecting the final remaining view |
| `list_database_templates` | List database row/page templates |
| `get_database_template` | Read a template's default properties and Markdown body |
| `create_database_template` | Create a database template with default properties and Markdown body |
| `update_database_template` | Update a template's metadata, defaults, or Markdown body |
| `duplicate_database_template` | Duplicate a database template |
| `delete_database_template` | Delete a database template |
| `query_database` | Read database rows as a Markdown table, optionally applying a saved view |
| `add_database_row` | Create a database row, using the default template unless skipped |
| `update_database_row` | Update a database row |
| `move_database_row` | Move a database row before or after another row in the same database |
| `trash_database_row` | Move a database row subtree to trash |
| `restore_database_row` | Restore a trashed database row subtree |
| `delete_database_row_forever` | Permanently delete a database row subtree |
| `add_database_property` | Add a database property, with optional row-panel display settings |
| `update_database_property` | Update a database property's name, options, config, and row-panel display settings |
| `delete_database_property` | Delete a database property and clean row/view references |
| `prepare_file_upload` | Create a backend-validated file upload grant |
| `list_files` | List backend-tracked file upload records |
| `delete_file` | Delete a backend-tracked file upload record and stored object when present |
| `cleanup_expired_files` | Expire stale pending upload grants |
| `get_file_report` | Read workspace or organization file usage and maintenance statistics |
| `create_file_download_url` | Create a short-lived backend-validated file download URL |

Content is exchanged as Markdown — headings, bulleted/numbered lists, to-dos
(`- [ ]` / `- [x]`), toggles (`▶` or `▸`), callouts (`> 💡 Note`), quotes,
columns (`::: columns`), tables, equations, media links, and fenced code blocks
map to the corresponding block types. Inline bold, italic, strikethrough, code,
links, and page mentions (`[[Page]](/p/page-id)`) are preserved in text-bearing
blocks. Date mentions use `hanji://date/YYYY-MM-DD` links, and person
mentions use `hanji://person/user-id` links.

## Run

```bash
cd mcp
npm install
HANJI_EDGEBASE_URL=http://localhost:8787 node src/index.mjs
```

## Verify

```bash
cd mcp
npm run check
npm run smoke
```

`npm run smoke` starts the MCP server over stdio and verifies that the core tool
list is advertised, required MCP resources including
`notion://docs/mcp-compatibility-report` are readable, policy output schemas
include provisioning metadata, and loose `z.any()` schemas are not reintroduced.
It does not call workspace-mutating tools, so it can run without a live EdgeBase
backend.

When the local EdgeBase backend is running, also run:

```bash
npm run smoke:live
```

`smoke:live` signs in temporary local users, passes their bearer tokens to MCP
with `HANJI_MCP_AUTH_MODE=token`, checks read-only/workspace/database
allowlist policy enforcement through separate MCP processes, verifies policy-file
and environment allowlist intersection, verifies service-principal provisioning
metadata in `get_mcp_access_policy` and MCP client audit events for mutating
calls, calls real MCP tools through stdio, and verifies
that the MCP server can bootstrap the workspace, list organizations, read and search the
organization directory with profile summaries, create/update/delete organization
groups and add/remove group members,
add/verify/remove organization domains, update
organization workspace creation, domain signup, storage limit, and sharing policy, expose recent organization
audit output and audit filtering for organization, workspace invitation, and
workspace member lifecycle events, expose organization member removal, expose organization and workspace owner transfer,
list/create/delete empty workspaces,
create/list/search/delete a page inside a non-default workspace,
update the current workspace profile, invite/accept/revoke email invitations,
add/update/remove known members, create/read/cleanup pages, append/replace page content,
verify user-id and email-principal direct page sharing with non-workspace-member
MCP clients,
move/duplicate/trash/restore/delete pages, organization member removal with content ownership reassignment,
comments, cross-user notification
list/read state, Share to web links, explicit page permissions, direct page
view/comment/edit access boundaries and direct database view/edit/full-access
boundaries for non-workspace-member MCP users, file upload
grants, file reports, databases, database views/properties, and database row
create/update/move/query/lifecycle operations through the backend product API at
`HANJI_EDGEBASE_URL` (default: `http://127.0.0.1:8787`).

## Client guides

Per-client setup guides with copy-paste configs live in
[`docs/guides/`](docs/guides/):

- [Claude Code](docs/guides/claude-code.md) — `claude mcp add` and project `.mcp.json`
- [Claude Desktop](docs/guides/claude-desktop.md) — `claude_desktop_config.json`
- [Cursor](docs/guides/cursor.md) — `.cursor/mcp.json`
- [VS Code (GitHub Copilot)](docs/guides/vscode-copilot.md) — `.vscode/mcp.json`
- [Generic stdio client](docs/guides/generic-stdio.md) — the command/args/env contract for any MCP client

## Register with Claude Code

```bash
claude mcp add hanji -- node /path/to/hanji/mcp/src/index.mjs
```

Or add to an MCP client config (e.g. `.mcp.json` / `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "hanji": {
      "command": "node",
      "args": ["/path/to/hanji/mcp/src/index.mjs"],
      "env": {
        "HANJI_EDGEBASE_URL": "http://localhost:8787",
        "HANJI_MCP_AUTH_MODE": "token",
        "HANJI_MCP_ACCESS_TOKEN": "..."
      }
    }
  }
}
```

> Local dev may use anonymous auth as a bootstrap fallback, but deployed or
> multi-user setups should provide an explicit user or service token. Keep MCP
> traffic on the Hanji product API rather than bypassing product
> permissions with raw table access.
