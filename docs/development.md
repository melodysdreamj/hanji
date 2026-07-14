# Local development

How to run and configure the full stack on your machine. For the package
layout and data model, see [architecture.md](architecture.md); for the
verification/smoke catalog, see [verification.md](verification.md).

## Prerequisites

- Node.js ≥ 22.12
- npm

## Install

```bash
npm --prefix backend install
npm --prefix web install
npm --prefix mcp install
```

The published `@edge-base/*` registry packages are used as installed. The
actual local server is opened by `backend` when `npm run dev` runs
`edgebase dev`.

## One-time dev environment setup

The setup script generates the git-ignored runtime secret files and enables
browser first-run setup. It does not ask for or store an administrator email or
password. Safe to re-run; existing cryptographic secrets are preserved:

```bash
node scripts/setup-dev-env.mjs
```

Start the backend, open the app, and choose the first server administrator name,
email, and password in the browser. The durable first-run claim closes after one
administrator is created. Details: [master-account.md](master-account.md).

### One-time local namespace migration

If this checkout already has local state or ignored environment files from a
pre-Hanji build, stop every local EdgeBase/Wrangler process before migrating.
Preview the idempotent migration first; it refuses destination collisions and
never prints environment values:

```bash
node scripts/migrate-hanji-local-namespace.mjs --dry-run
# After snapshotting backend/.edgebase, root .edgebase, and every target ignored env file:
node scripts/migrate-hanji-local-namespace.mjs --apply --backup-confirmed
```

Fresh checkouts do not need this step. The migration is deliberately explicit
instead of running during setup or refresh, because renaming active Durable
Object storage while a runtime is writing to it is unsafe. Apply mode detects
project-owned EdgeBase/Wrangler/workerd processes and refuses to run until they
stop. If an automatic rollback reports any failure, keep the runtime stopped
and restore the snapshot before retrying.

The setup command also refuses pre-Hanji variable names inherited from the
current shell. Rename or unset those variables first; setup reports names only
and never prints their values.

## Run the stack

**1. Backend** (EdgeBase, port 8787, admin dashboard at `/admin`):

```bash
cd backend
npm run dev
```

> EdgeBase loads the local JWT and account secrets from `.env.development` /
> `.dev.vars` (created by the setup script above). The dev command allowlists
> only the explicit guest-login and browser-setup flags for config evaluation; it does not
> expose the rest of the parent shell environment to the worker. On first boot
> the browser shows the first-administrator form; later boots use the normal
> sign-in form.

**2. Web app** (Vite SPA, port 3000):

```bash
cd web
npm run dev
```

Open http://localhost:3000.

**3. MCP server** (optional, for AI agents):

```bash
cd mcp
HANJI_MCP_AUTH_MODE=token HANJI_MCP_ACCESS_TOKEN=... \
  claude mcp add hanji -- node "$(pwd)/src/index.mjs"
```

Optional MCP policy environment variables can narrow a client to read-only
mode or specific workspace/page/database ids:
`HANJI_MCP_READ_ONLY=true`,
`HANJI_MCP_ALLOWED_WORKSPACE_IDS=...`,
`HANJI_MCP_ALLOWED_PAGE_IDS=...`, and
`HANJI_MCP_ALLOWED_DATABASE_IDS=...`.

See [`mcp/README.md`](https://github.com/melodysdreamj/hanji/blob/main/mcp/README.md) for the available tools and
per-client setup guides.

## Developing against a local EdgeBase source tree

Optional. If you also work on EdgeBase itself, place (or point to) a checkout
and link it. The default location is a sibling directory `../edgebase`;
override with `EDGEBASE_LOCAL_PATH` (or `EDGEBASE_ROOT`). Dependency
installation replaces local package links, so re-run the link script after any
later install:

```bash
node scripts/link-local-edgebase.mjs
```

To verify whether the links point at a local EdgeBase checkout without
rewriting `node_modules`:

```bash
node scripts/link-local-edgebase.mjs --check
# or, the same check exposed by the backend:
npm --prefix backend run verify:local-edgebase
```

## Serving the built SPA from the backend

For packaged/runtime serving, build the SPA first:

```bash
cd web
npm run build
```

`backend/edgebase.config.ts` points EdgeBase at `../web/dist` with
`spaFallback: true`, so an EdgeBase runtime can serve both API traffic and
Notion-style frontend URLs from the same origin.

If a check reports a stale served SPA bundle, refresh the local EdgeBase dev
runtime. The refresh command checks whether tracked frontend inputs are newer
than `web/dist/index.html` and rebuilds `web/dist` first when needed:

```bash
npm --prefix backend run dev:refresh
```

## Email delivery

Hanji uses Cloudflare Email Service as its first-party mail path. For local,
Docker, or packaged runtimes, configure REST delivery:

```bash
HANJI_AUTH_EMAIL_FROM=noreply@example.com
HANJI_CLOUDFLARE_EMAIL_ACCOUNT_ID=...
HANJI_CLOUDFLARE_EMAIL_API_TOKEN=...
```

Replace the example domain with a real public mail domain. The account ID is
exactly 32 hexadecimal characters and the API token must be an independent
strong value of at least 40 characters.

For hosted Cloudflare Workers, the tracked Wrangler file declares the exact
`EMAIL` `send_email` binding:

```bash
HANJI_CLOUDFLARE_EMAIL_BINDING=EMAIL
```

Release preflight accepts binding-only delivery only while that exact static
declaration is present. A renamed/manual binding without that proof needs the
REST credential pair.

## Social sign-in and passkeys

Social login is opt-in: set `HANJI_AUTH_OAUTH_PROVIDERS`, provide matching
`HANJI_OAUTH_<PROVIDER>_CLIENT_ID` /
`HANJI_OAUTH_<PROVIDER>_CLIENT_SECRET` values. The public runtime-config
endpoint exposes only provider names whose backend credentials are complete,
and the sign-in screen derives its buttons from that response; there is no
separate frontend provider list that can drift from the server.
Strict releases use exact lowercase `HANJI_AUTH_OAUTH_PROVIDERS=off` when
social sign-in is disabled, which clears retained provider enablement.

Register this exact provider callback for each enabled provider (replace the
placeholder with the canonical `HANJI_APP_ORIGIN` and provider name):

```text
https://app.example.com/api/auth/oauth/<provider>/callback
```

For example, GitHub uses
`https://app.example.com/api/auth/oauth/github/callback`. The later
`/auth/callback` URL is Hanji's internal browser-resume route and is not the
callback registered in the provider console.

Email verification, password-reset, and email-change messages likewise land on
real same-origin Hanji routes under `/auth/`. Their single-use bearer tokens
stay in URL fragments and AuthGate removes them from browser history before it
verifies the action.

Passkeys are currently disabled in `backend/edgebase.config.ts` and are not a
release-environment requirement. When the feature is deliberately re-enabled,
set `HANJI_PASSKEY_RP_ID` and `HANJI_PASSKEY_ORIGINS` together so the WebAuthn
relying-party ID and exact public HTTPS origins match the URL users actually
open, then restore the real-browser authenticator release smoke.

## Anonymous dev guest login

Anonymous auth is kept only as an explicit local-origin bootstrap escape hatch
while the app is under development. The frontend flag lets the button exist in
a local build, and the EdgeBase dev runtime must also opt in through
`HANJI_ALLOW_DEV_GUEST_LOGIN=true`:

```bash
VITE_ALLOW_ANONYMOUS_BOOTSTRAP=true
```

## SSRF guard tuning

Caller-supplied URL fetches are SSRF-guarded (see
[architecture.md](architecture.md#ssrf-guarding)). Air-gapped or
DoH-unreachable local/self-hosted development runtimes can tune this. Never
disable the DNS check on an internet-reachable production deployment: release
preflight rejects `off`, `false`, and `0` because hostname-based private-address
SSRF would otherwise pass the literal-host check.

```bash
# Skip the DNS resolution step (literal-host checks still apply).
HANJI_SSRF_DNS_CHECK=off
# Use a different DNS-over-HTTPS resolver (default: https://cloudflare-dns.com/dns-query).
HANJI_SSRF_DOH_URL=https://dns.google/resolve
```

Those overrides are development/self-host controls only. Strict public release
pins `HANJI_SSRF_DOH_URL=https://cloudflare-dns.com/dns-query` so a stale or
operator-controlled resolver cannot weaken hostname-based SSRF checks.

## Notion import secret

Stored Notion import connections encrypt credentials with a server-side secret
and never expose raw tokens through web or MCP responses. Configure this
before creating saved connections:

```bash
HANJI_NOTION_IMPORT_SECRET=replace-with-a-long-random-secret
```

Public releases also explicitly pin `HANJI_NOTION_API_BASE` to
`https://api.notion.com/v1` and `HANJI_NOTION_OAUTH_AUTH_URL` to
`https://api.notion.com/v1/oauth/authorize`. Alternate bases remain available
for local mock import verification, but release preflight rejects them. Strict
release also requires `HANJI_NOTION_OAUTH_ENABLED=false|true`: `false` pairs
with four explicit empty OAuth declarations to clear stale Worker secrets;
`true` requires all four strong, complete values and the exact same-origin
`/?notion_import_oauth=1` redirect. At runtime, only exact lowercase `true`
enables the Notion OAuth helpers, actions, stored OAuth credentials, and public
capability bit; `false`, a missing value, and other spellings ignore retained
client, secret, state, authorization, and redirect values.
