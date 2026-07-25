# Docker quick start

The published Hanji image is the recommended installation path for Docker
Desktop, a Linux Docker host, and container-capable NAS products. It starts
without a source checkout, environment file, or terminal setup code.

For Synology-specific screens, HTTPS reverse proxy, certificates, and
WebSocket settings, use the separate
[Synology DSM visual guide](deployment.md#synology-setup-wireframes).

## Image and platform

Use the immutable release tag:

```text
melodysdreamj/hanji:0.2.0-alpha.1
```

The Docker Hub image supports Linux AMD64 and ARM64. Docker selects the correct
platform automatically. The moving `alpha` tag follows the newest alpha;
`latest` is intentionally unavailable until a stable release exists.

Container releases publish the same verified multi-platform digest to Docker
Hub and `ghcr.io/melodysdreamj/hanji` in one release workflow. Publication is
accepted only after both registries expose matching AMD64/ARM64 manifests to an
anonymous client.

## Docker Desktop or another container UI

1. Pull `melodysdreamj/hanji:0.2.0-alpha.1` from Docker Hub.
2. Create a container and enable automatic restart.
3. Publish an unused host port to container `8787/TCP`. On a personal computer,
   host port `8787` is the simplest choice.
4. For durable, easy-to-find storage, map a named volume or dedicated host
   folder to container path `/data` with read/write access.
5. Set the logging driver to `local`, then add `max-size=10m` and
   `max-file=3`. If the UI does not expose per-container logging, use the
   one-command installation below or configure Docker's daemon default before
   creating the container. Do not silently inherit the unrotated `json-file`
   default.
6. From a terminal, run the image's `hanji-memory-limit.mjs` helper shown
   below. Set both the memory limit and total memory-plus-swap limit to its
   printed value. Capable hosts default to `max(2 GiB, 50% of detected RAM)`;
   automatic sizing requires at least 4 GiB of host RAM. This gives the ingress
   memory-pressure controller a finite cgroup boundary and prevents swap from
   hiding sustained pressure.
7. Leave the image's environment variables unchanged. In particular, the
   container normally remains on internal HTTP; a NAS or reverse proxy provides
   public HTTPS.
8. Start the container and open `http://localhost:<host-port>`.

Leaving the volume screen empty is valid for evaluation: the image declares
`/data`, so Docker creates an anonymous persistent volume. It survives
stop/start and restart, but its generated name is harder to identify, back up,
and reattach when replacing the container.

### A locally built image may not appear in your NAS container UI

If you build the Hanji image on the NAS instead of pulling it from a registry,
the container can be missing from Synology's Docker/Container Manager list even
though it is running normally.

Nothing is wrong with the container. Synology's older Docker package builds its
list from images it can resolve to a registry coordinate, and a locally built
tag such as `hanji:my-build` has none. Observed on DSM Docker 20.10.3: every
container from a registry image was listed, while locally built ones were not,
regardless of network mode — a `--network host` container pulled from a registry
was listed normally. Verify from a shell instead:

```bash
sudo docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}'
sudo docker logs --tail 100 --timestamps <container>
```

The practical consequence is that start, stop, restart, and log viewing for that
container happen over SSH rather than in the NAS UI. If you would rather manage
it from the UI, pull a published image such as `melodysdreamj/hanji:<version>`
rather than building locally on the NAS.

## One-command installation

This command keeps the service local to the computer and stores all persistent
state in the named volume `hanji-data`:

```bash
HANJI_IMAGE=melodysdreamj/hanji:0.2.0-alpha.1
HANJI_MEMORY_LIMIT="$(
  docker run --rm --entrypoint node "$HANJI_IMAGE" \
    /usr/local/bin/hanji-memory-limit.mjs
)"
printf 'Hanji memory limit: %s\n' "$HANJI_MEMORY_LIMIT"
docker run -d \
  --name hanji \
  --restart unless-stopped \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --memory "$HANJI_MEMORY_LIMIT" \
  --memory-swap "$HANJI_MEMORY_LIMIT" \
  -p 127.0.0.1:8787:8787 \
  -v hanji-data:/data \
  "$HANJI_IMAGE"
```

The `local` driver retains at most three 10 MB log segments for this container
and keeps `docker logs` working. Docker owns this stdout/stderr retention; it
is separate from Hanji's `/data` volume. Logging configuration is fixed at
container creation, so stop and recreate any older `hanji` container before
expecting this bound. Docker also recommends the `local` driver to prevent
disk exhaustion; see [Configure logging drivers](https://docs.docker.com/engine/logging/configure/)
and [Local file logging driver](https://docs.docker.com/engine/logging/drivers/local/).

Hanji logs each scheduled target's initial outcome once. Later successful
passes stay quiet; failed or ambiguous attempts remain error records, and the
first later success for that target emits one recovery record before becoming
quiet again. This keeps routine scheduler traffic from consuming the bounded
log budget while preserving actionable transitions.

The scheduler cursor at `/data/.hanji/self-host-schedule-state.json` is
rebuildable; durable runtime delivery records remain the execution authority.
If that regular file is truncated, oversized, or uses an incompatible schema,
Hanji moves its exact bytes to the fixed `.corrupt` sibling, names the
quarantine path in the container log, and regenerates the cursor. A later
incident replaces that sidecar instead of accumulating backups. Permission,
non-file-path, or quarantine failures still stop startup so filesystem
authority is never guessed.

The matching hard and swap limits create a finite cgroup boundary. The helper
rounds Linux's reserved-memory-adjusted total upward to the installed-GiB boundary and
then chooses the larger of 2048 MiB or half of that RAM: 4 GiB becomes
`2048m`, and 16 GiB becomes `8192m`. On a 2–3 GiB host it refuses automatic
sizing rather than starving DSM or another host service; use a host with 4 GiB
or more. The verified 1536 MiB minimum remains an explicit override for an
operator who has separately confirmed host headroom:

```bash
HANJI_MEMORY_LIMIT=1536m docker run --rm \
  --entrypoint node \
  -e HANJI_MEMORY_LIMIT \
  melodysdreamj/hanji:0.2.0-alpha.1 \
  /usr/local/bin/hanji-memory-limit.mjs
```

Use the same pattern with a larger finite value such as `10g` to loosen the
default. The helper rejects values below 1536 MiB, malformed/unlimited values,
and unknown RAM when no explicit override is provided. Hanji samples the whole
container at a shared bounded cadence; above 80% usage it rejects new HTTP and
WebSocket work with `429` and `Retry-After`, then reopens below 70%. Existing
request/body/import bounds still apply, and an already-running request is not
retroactively cancelled.

Runtime ownership and product-database health share one five-minute startup
budget. This avoids recycling a healthy but slow cold NAS open at the former
one-minute boundary while keeping a hung startup finite. Unusually slow
storage can set `HANJI_STARTUP_TIMEOUT_MS` to an integer from `60000` through
`1800000` milliseconds; the source launcher passes the same value to its outer
health wait and the container. Increase it only after checking the container
log for continuing startup progress rather than a persistent error.

Open [http://localhost:8787](http://localhost:8787). The first browser visit
creates the server administrator using name, email, and password fields. There
is no installation code to retrieve from the container log. Keep a fresh
instance private until the administrator is created because the first visitor
can claim it.

Useful checks:

```bash
docker ps --filter name=hanji
docker inspect --format '{{json .HostConfig.LogConfig}}' hanji
docker logs --tail 100 hanji
curl http://127.0.0.1:8787/api/health
```

The inspect output must report type `local`, `max-size` `10m`, and `max-file`
`3`. If it does not, back up `/data` and recreate the container with the
command above; restarting an existing container does not change its logging
configuration.

Stop and start the same container without losing data:

```bash
docker stop hanji
docker start hanji
```

## Notion-compatible API and hosted MCP

The Docker image serves the web app, the Notion-compatible REST and Admin APIs,
and the hosted MCP server from the same port and the same permission-checked
Hanji data. No second container or MCP port is required.

| Surface | URL |
| --- | --- |
| Notion-compatible REST base | `https://hanji.example.com/api/functions/v1` |
| Explicit canonical REST base | `https://hanji.example.com/api/functions/notion/v1` |
| Base URL for clients that append `/v1` | `https://hanji.example.com/api/functions` |
| Notion-compatible Admin API v1 base | `https://hanji.example.com/api/functions/admin/v1` |
| Explicit canonical Admin API v1 base | `https://hanji.example.com/api/functions/notion/admin/v1` |
| Integration OAuth authorization | `https://hanji.example.com/api/functions/notion-oauth-authorize` |
| Hosted MCP (Streamable HTTP) | `https://hanji.example.com/api/functions/mcp` |
| MCP authorization-server metadata | `https://hanji.example.com/api/functions/mcp-oauth-authorization-server` |
| MCP protected-resource metadata | `https://hanji.example.com/api/functions/mcp-oauth-protected-resource` |

Replace `https://hanji.example.com` with the exact origin used to open Hanji.
Local-only callers can use `http://127.0.0.1:8787`; clients on another device
must use the public HTTPS origin described in
[HTTPS and remote access](#https-and-remote-access). For OAuth and MCP, set
`HANJI_APP_ORIGIN` to that exact origin, without a trailing slash, whenever the
container is recreated.

The compatibility release guard covers the 48 official Notion REST operations
and 20 official Notion MCP tools in the `2026-03-11` reference manifest. The
separately authenticated Admin API locks the current 13 operations at
`2026-06-01`. Hanji also exposes its broader native MCP tool set. All calls
still enforce their own account or organization identity, resource scope, and
product permission boundaries.

### REST API

Send the Hanji-issued access token as a bearer token and use
`Notion-Version: 2026-03-11`. The token for this endpoint is issued by Hanji;
it is not a Notion `ntn_...` import token. Legacy clients may request
`2025-09-03` or `2022-06-28`; omitting the header selects `2026-03-11`.

```bash
HANJI_ORIGIN=https://hanji.example.com
HANJI_API_TOKEN=replace-with-a-Hanji-access-token

curl --fail-with-body --silent --show-error \
  "$HANJI_ORIGIN/api/functions/v1/users/me" \
  -H "Authorization: Bearer $HANJI_API_TOKEN" \
  -H "Notion-Version: 2026-03-11"
```

JSON writes use the same headers plus `Content-Type: application/json`. For
example, a Notion-shaped search request is:

```bash
curl --fail-with-body --silent --show-error \
  --request POST \
  "$HANJI_ORIGIN/api/functions/v1/search" \
  -H "Authorization: Bearer $HANJI_API_TOKEN" \
  -H "Notion-Version: 2026-03-11" \
  -H "Content-Type: application/json" \
  --data '{"query":"roadmap","page_size":20}'
```

For a third-party Notion-compatible integration, register one confidential
OAuth client as container configuration. Keep this file outside the repository
and preserve it for every container recreation:

```dotenv
HANJI_APP_ORIGIN=https://hanji.example.com
HANJI_NOTION_COMPAT_OAUTH_CLIENT_ID=example-client
HANJI_NOTION_COMPAT_OAUTH_CLIENT_SECRET=replace-with-a-long-random-secret
HANJI_NOTION_COMPAT_OAUTH_REDIRECT_URIS=https://integration.example.com/oauth/callback
HANJI_NOTION_COMPAT_OAUTH_CLIENT_NAME=Example integration
```

For multiple integrations, keep `HANJI_APP_ORIGIN` and replace the four
single-client variables with one compact JSON registry:

```dotenv
HANJI_NOTION_COMPAT_OAUTH_CLIENTS=[{"client_id":"client-a","client_name":"Integration A","client_secret":"replace-with-a-long-random-secret","redirect_uris":["https://integration-a.example.com/oauth/callback"]}]
```

Protect the file, then add `--env-file /secure/path/hanji-api.env` to the
normal `docker run` command. The authorization request uses this URL shape:

```text
https://hanji.example.com/api/functions/notion-oauth-authorize?client_id=example-client&redirect_uri=https%3A%2F%2Fintegration.example.com%2Foauth%2Fcallback&response_type=code&owner=user&state=RANDOM_CSRF_VALUE
```

After the user signs in, chooses a workspace and content scope, and approves
the request, exchange the returned one-time `code` at the REST token endpoint:

```bash
HANJI_CLIENT_ID=example-client
HANJI_CLIENT_SECRET=replace-with-the-configured-secret
HANJI_REDIRECT_URI=https://integration.example.com/oauth/callback
HANJI_AUTHORIZATION_CODE=replace-with-the-returned-code

curl --fail-with-body --silent --show-error \
  --user "$HANJI_CLIENT_ID:$HANJI_CLIENT_SECRET" \
  --request POST \
  "$HANJI_ORIGIN/api/functions/v1/oauth/token" \
  -H "Content-Type: application/json" \
  --data "{\"grant_type\":\"authorization_code\",\"code\":\"$HANJI_AUTHORIZATION_CODE\",\"redirect_uri\":\"$HANJI_REDIRECT_URI\"}"
```

The response contains `access_token` and `refresh_token`. Store both as
secrets, verify the returned `state` before exchanging the code, and use the
same client credentials with `grant_type: refresh_token` when refreshing.

### Admin API

The Admin API is for organization compliance automation and is separate from
the ordinary REST and MCP authorization flows. Sign in as an organization owner
or security admin, open **Settings → Enterprise controls → Notion-compatible
Admin API**, and create an organization bot token. The `ntn_admin_...` secret is
shown only by that creation response; later list and revoke calls return only
redacted metadata. Hanji stores its SHA-256 hash, and an administrator can
narrow it by capability, workspace IDs, legal-hold IDs, and an optional
expiration.

Every Admin API request needs the bot token and the exact header
`Notion-Version: 2026-06-01`. A Hanji account, integration OAuth, MCP, or Notion
import token cannot be substituted for it. The current operation registry is:

| Method and path | Required capability |
| --- | --- |
| `POST /v1/legal_holds/{legal_hold_id}/export` | `legal-hold:export` |
| `GET /v1/legal_holds/{legal_hold_id}` | `legal-hold:read` |
| `PATCH /v1/legal_holds/{legal_hold_id}` | `legal-hold:write` |
| `GET /v1/legal_holds/{legal_hold_id}/users` | `legal-hold:read` |
| `POST /v1/legal_holds/{legal_hold_id}/users` | `legal-hold:write` |
| `GET /v1/legal_holds` | `legal-hold:read` |
| `POST /v1/legal_holds` | `legal-hold:write` |
| `GET /v1/legal_holds/{legal_hold_id}/workspaces` | `legal-hold:read` |
| `POST /v1/legal_holds/{legal_hold_id}/release` | `legal-hold:write-high-impact` |
| `DELETE /v1/legal_holds/{legal_hold_id}/users/{user_id}` | `legal-hold:write` |
| `POST /v1/exports` | `workspace:export` |
| `GET /v1/legal_holds/{legal_hold_id}/spaces/{space_id}/pages` | `legal-hold:read` |
| `POST /v1/managed_users/revoke_session` | `managed-user-session:write` |

For example, list the legal holds visible to a scoped bot:

```bash
HANJI_ORIGIN=https://hanji.example.com
HANJI_ADMIN_TOKEN=replace-with-the-once-displayed-admin-token

curl --fail-with-body --silent --show-error \
  "$HANJI_ORIGIN/api/functions/admin/v1/legal_holds" \
  -H "Authorization: Bearer $HANJI_ADMIN_TOKEN" \
  -H "Notion-Version: 2026-06-01"
```

Creation and export requests support `Idempotency-Key` replay protection. Legal
hold export delegates to Hanji's canonical JSONL discovery export, while
workspace Markdown and HTML exports delegate to the canonical Markdown
exporter. The official request schema also accepts `export_type: "pdf"`, but
the resulting job currently fails because Hanji has no canonical PDF renderer;
do not treat an accepted/queued response as a successful PDF artifact.
Comment-inclusive, file-excluding, current-view-only, and teamspace-scoped
workspace export options likewise fail closed when the canonical exporter
cannot honor them. This is an honest compatibility boundary, not a plan gate.

### Hosted MCP

Sign in to Hanji, open **Settings → Account console → AI connections**, and
copy the displayed MCP server URL or one of the ready-made client snippets.
For example:

```bash
claude mcp add --transport http hanji \
  https://hanji.example.com/api/functions/mcp
```

```json
{
  "mcpServers": {
    "hanji": {
      "url": "https://hanji.example.com/api/functions/mcp"
    }
  }
}
```

An OAuth-capable client discovers Hanji's authorization endpoints, opens the
Hanji consent screen, and uses authorization-code + PKCE automatically. The
user can authorize all accessible workspaces or narrow the connection to
selected workspaces. Connections can be reviewed or revoked from the same
**AI connections** screen.

Discovery follows the `resource_metadata` URL in the endpoint's `401`
challenge. Hanji advertises the two metadata URLs in the table above directly;
do not replace them with an unadvertised `/.well-known/...` path.

For a client without remote OAuth support, the screen can create a manual MCP
access/refresh-token pair that is shown once. Prefer OAuth when available, do
not put either token in a repository or image, and revoke the connection if a
token is exposed. The container generates `HANJI_MCP_OAUTH_SECRET` on first
start and persists it under `/data`; this server signing secret is not a client
token and must never be copied into an MCP configuration.

The official `notion-query-data-sources` tool supports `data.mode = "sql"`
without a Hanji plan gate. A query references one permitted
`collection://...` data source and runs as bounded source windows with an
opaque continuation cursor. For example:

```json
{
  "mode": "sql",
  "workspace_id": "WORKSPACE_ID",
  "data_source_urls": [
    "collection://TASKS_DATA_SOURCE_ID"
  ],
  "query": "SELECT \"Name\", \"Priority\" FROM \"collection://TASKS_DATA_SOURCE_ID\" WHERE \"Status\" = ? ORDER BY \"Priority\" DESC, \"Name\" ASC LIMIT 100",
  "params": ["Open"]
}
```

The streaming subset supports bind-safe filters, scalar projections and
expressions, direct-property multi-key ordering, and literal
`LIMIT`/`OFFSET`. Direct ordering is delegated to the canonical database
query, so it remains global and deterministic across cursor windows. Each call
reads at most ten 100-row source windows and returns at most 500 rows; the
default response window is 100. Empty snapshot-build progress windows can
return `has_more: true`; replay `next_cursor` until data arrives or the
source drains. Stored source size has no fixed execution ceiling.

Cross-window SQL shapes—`DISTINCT`, grouping/aggregates, joins,
CTEs/subqueries, unions, and computed or projected-alias ordering—fail after
source authorization and before row reads. The parser also enforces 32 KiB
SQL, 256 bind parameters, depth 16, and 512 AST nodes, and rejects comments,
writes, window functions, parameterized `LIMIT`/`OFFSET`, and unlisted
functions/operators. Bind values are never interpolated into SQL. See the
[complete MCP guide](https://github.com/melodysdreamj/hanji/blob/main/mcp/README.md#notion-compatible-sql-queries)
for hosted and stdio cursor details.

Organization owners and security admins can also enable the approved MCP client
policy per workspace in **Settings → Enterprise controls**. Authorization and
every hosted MCP call re-check the client ID. Removing a client therefore
blocks an existing token on its next call; an all-workspaces grant continues to
expose other approved workspaces only. Existing scopes and page/database
allowlists still narrow approved calls. Policy changes and blocked calls are
recorded in the organization audit log. Approve registered or dynamically
registered OAuth client IDs, plus the reserved `manual-token` client ID only
when that fallback should remain available for a governed workspace.

Governance writes atomically re-check the administrator role and controls
version while updating the policy version and audit record. Exact retries do
not duplicate audit entries, concurrent writes retry instead of overwriting one
another, and malformed or duplicate stored policy rows fail closed.

The source-tree `mcp/` package remains available for clients that require a
locally spawned stdio server. Docker users whose client supports remote HTTP
should use the hosted URL above. See the
[complete MCP tool and stdio guide](https://github.com/melodysdreamj/hanji/blob/main/mcp/README.md)
for the native tool catalog and local-process policy options.

## Data and backup

Everything that must survive container replacement lives under `/data`:

- pages, databases, and workspace state
- uploaded files
- generated session, encryption, service, and MCP secrets
- first-administrator setup completion

Back up the whole volume or mapped directory as one unit. For the named volume
used above, this creates a compressed backup in the current directory:

```bash
docker run --rm \
  --user 0:0 \
  --entrypoint tar \
  -v hanji-data:/data:ro \
  -v "$PWD":/backup \
  melodysdreamj/hanji:0.2.0-alpha.1 \
  -C /data -czf /backup/hanji-data-backup.tar.gz .
```

Test restoration into a different volume before relying on a backup:

```bash
docker volume create hanji-data-restored
docker run --rm \
  --user 0:0 \
  --entrypoint tar \
  -v hanji-data-restored:/data \
  -v "$PWD":/backup:ro \
  melodysdreamj/hanji:0.2.0-alpha.1 \
  -C /data -xzf /backup/hanji-data-backup.tar.gz
```

Start a temporary container on `hanji-data-restored`, sign in, and inspect a
representative page and uploaded file. Remove the temporary container and
volume after the check. A backup is not considered proven until this restore
test succeeds.

Do not delete `hanji-data` during an update. A host-directory mapping may be
used instead, for example `-v /srv/hanji:/data`; it must be dedicated to Hanji
and writable by the container.

## Updating the image

Back up `/data`, then pull the new immutable tag and recreate only the
replaceable container. The named volume remains intact, and recreation also
applies the bounded logging policy:

```bash
HANJI_VERSION=0.2.0-alpha.1 # replace with the new immutable release tag
docker pull "melodysdreamj/hanji:$HANJI_VERSION"
HANJI_MEMORY_LIMIT="$(
  docker run --rm --entrypoint node \
    "melodysdreamj/hanji:$HANJI_VERSION" \
    /usr/local/bin/hanji-memory-limit.mjs
)"
printf 'Hanji memory limit: %s\n' "$HANJI_MEMORY_LIMIT"
docker rm -f hanji
docker run -d \
  --name hanji \
  --restart unless-stopped \
  --log-driver local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --memory "$HANJI_MEMORY_LIMIT" \
  --memory-swap "$HANJI_MEMORY_LIMIT" \
  -p 127.0.0.1:8787:8787 \
  -v hanji-data:/data \
  "melodysdreamj/hanji:$HANJI_VERSION"
```

Use the previous immutable tag with the same `hanji-data` volume to roll back
the container image. Restore a data backup as well if a future release changes
the persisted data format incompatibly.

Hanji records the whole-volume compatibility generation in
`/data/.hanji/persistence-format.json`. EdgeBase applies additive table changes
and registered table migrations during startup; Hanji advances the volume
marker only after the product database health check succeeds. An older image
refuses a volume created by a newer unsupported format and tells you to use a
compatible image or restore an operator-created pre-upgrade backup. Do not edit
this marker by hand.

Hanji does not create an automatic pre-upgrade archive. Before the runtime
starts, every whole-volume migration step must declare that it is metadata-only
or run inside one EdgeBase transaction. Metadata-only steps cannot register a
write callback, and a transactional step is rejected unless its transaction
runner is present. A migration that needs non-atomic filesystem and database
changes is not admitted; it requires a separate backup and rollback design
before release. Periodic whole-volume backups and retention remain owned by the
operator.

Repository releases gate the image with an automated full-volume rehearsal:
it seeds a synthetic account, workspace, page, block, database, row, and
uploaded file; archives `/data`; starts the target image on the original
volume; restores the archive into a new volume; verifies the records, exact
uploaded bytes, and persisted authentication secret in both; and proves that
an unsupported future marker fails closed. Source-build operators can run the
same check against an already-built image:

```bash
npm --prefix backend run verify:upgrade-restore -- \
  --target-image hanji:local
```

Pass `--source-image <older-tag>` as well to rehearse a real cross-release
upgrade. The default uses the target image as both ends and simulates a legacy
pre-marker volume, which keeps CI deterministic while exercising migration,
operator backup/restore, and future-format rejection.

## HTTPS and remote access

The registry image listens on HTTP port `8787` inside the container. That is
correct for local Docker Desktop access. For access from another computer or
the internet:

- keep the mapped HTTP port private
- terminate HTTPS at a trusted reverse proxy
- forward the original `Host` and `X-Forwarded-Proto: https` headers
- enable WebSocket forwarding for realtime features
- expose only the public HTTPS port through the router/firewall

Do not change the container to HTTPS merely because the proxy uses HTTPS.
Normal password login behind a standard HTTPS reverse proxy needs no Hanji
environment-variable changes. Account OAuth and emailed auth actions use the
optional exact `HANJI_AUTH_ORIGIN`; passkeys use their dedicated RP/origin
settings. These values are independent of custom-site routing; see
[Ingress and HTTPS](deployment.md#ingress-and-https-docker--pack).

Synology users should continue with the
[Synology DSM visual guide](deployment.md#synology-setup-wireframes).

## Building from source

Building an image from a source checkout is a development and audit path, not
required for normal installation:

```bash
git clone https://github.com/melodysdreamj/hanji && cd hanji
npm --prefix backend install && npm --prefix web install
bash scripts/selfhost-docker.sh up --build
```

The source helper supplies local HTTPS and supports `status`, `logs`, and
`down`. See [Local development](development.md) and
[Deployment](deployment.md) for advanced configuration and verification.
