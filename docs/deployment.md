# Deployment

Hanji deploys as an EdgeBase app: the backend serves both the API and the
built SPA from one origin. Build the SPA first (`npm --prefix web run build`),
then use the EdgeBase deploy targets below.

## Master account on every runtime

The interactive setup script is a local-dev convenience. On every non-dev
deployment the master account travels as **environment variables** — the
server provisions it on first boot, exactly like dev:

- **Docker**: put `HANJI_MASTER_EMAIL` / `HANJI_MASTER_PASSWORD` in
  the `--env-file` you pass to `edgebase docker run` (alongside the JWT/
  SERVICE secrets).
- **Cloudflare**: set them in `backend/.env.release` — the deploy preflight
  (`npm --prefix backend run preflight:deploy`) refuses to deploy without
  them, and `edgebase deploy` syncs them to Cloudflare secrets.
- **Portable pack**: export them in the process environment before starting
  the packed runtime.

A fresh instance started **without** master credentials refuses to
initialize: the sign-in screen explains how to restart with them, and account
creation is rejected server-side. The password is only consulted when the
account is first created — rotate it later in Account Security. Details:
[master-account.md](master-account.md).

## Self-hosted HTTPS (Docker / pack)

### One command (recommended)

```bash
scripts/selfhost-docker.sh up
```

This builds the image, generates persistent secrets + a master account, issues
a locally-trusted certificate (via `mkcert` when installed, otherwise a
self-signed one), runs the container over HTTPS, verifies that the persistence
volume has at least 512 MiB free, waits for both runtime and product-database
readiness, provisions the master account, and only then prints the URL and
credentials. A failed capacity, readiness, or bootstrap check removes the
unhealthy container but keeps its data volume. Re-running reuses the same
secrets, certificate, and `hanji-data` volume. The certificate's private key
stays mode `0600` in both the gitignored host state and the Docker-managed
`hanji-certs` volume; it is never made world-readable just to cross a host UID
boundary. Override with `--port N`,
`--email`, `--password`, `--build` (force image rebuild), or `--http` (plain
HTTP for a proxy-terminated setup); manage the container with the `down`,
`logs`, and `status` subcommands. Advanced operators can change the free-space
floor with `HANJI_DOCKER_MIN_FREE_KB`. All state lives in the gitignored
`.edgebase/docker/`.
For a browser padlock with no warning, run `mkcert -install` once (it modifies
your OS trust store and asks for your password). The rest of this section
explains the underlying mechanism and the manual path.

### Why HTTPS is required

Hanji ships with `release: true`, and the browser signs in over EdgeBase's
HttpOnly refresh-cookie transport. Release mode requires a **secure origin** for
that cookie, so a self-hosted instance reached over plain `http://localhost`
fails sign-in with `400 "Cookie authentication requires HTTPS in release mode."`
(`insecure-cookie-config`). The fix is to serve HTTPS — the same model Synology
DSM and similar appliances use — not to disable release mode.

The Docker image can terminate TLS in-process. Add to the `--env-file` you pass
to `docker run` / `edgebase docker run`:

```bash
LOCAL_PROTOCOL=https
HANJI_APP_ORIGIN=https://localhost:8787
HANJI_PASSKEY_RP_ID=localhost
HANJI_PASSKEY_ORIGINS=https://localhost:8787
```

With `LOCAL_PROTOCOL=https` and no certificate paths, the runtime generates a
self-signed certificate; open `https://localhost:8787`, trust it once, and
sign-in works (verified: `200 OK` with a `__Host-…-refresh; Secure` cookie).
For a stable, OS-trustable certificate that survives restarts, mount your own
and set `HTTPS_CERT_PATH` / `HTTPS_KEY_PATH` (e.g. under the `/data` volume).

If you instead terminate TLS at a reverse proxy and forward HTTP upstream, set
`trustSelfHostedProxy: true` in `edgebase.config.ts` and have the proxy send
`X-Forwarded-Proto: https`; only then is a forwarded HTTP request treated as
secure. The port-mapped container never sees a loopback client IP, so the
local-development exemption does not apply to a self-hosted runtime — HTTPS is
the only supported path for browser sign-in.

## Release environment gate

Cloudflare release deploys read `backend/.env.release`. In strict mode this
must be a regular file (not a symlink or directory) with mode `0600`, or `0400`
for an intentionally read-only secret file. Required assignments must be
declared in the file even when CI supplies their values as shell overrides;
this makes the file an auditable release manifest and ensures safe values
overwrite stale Worker secrets.

The tracked Wrangler flags include both `nodejs_compat` and
`nodejs_compat_populate_process_env`; strict preflight refuses a config that
would compile successfully but hide release secrets from config-time
`process.env`.

The gate rejects development/test runtime overrides, mock mail endpoints,
action-URL overrides, enabled debug/proxy-trust flags, reserved or private
domains, non-canonical origins, reserved email domains, weak/reused secrets,
and incomplete JWT rotation pairs. The app origin and any configured passkey
origins must resolve only to public A/AAAA addresses. Notion API/OAuth and SSRF
resolver endpoints are pinned to their documented upstream values.
Development guest/auto-login flags, the rate-limit profile, and DNS checking
must be explicitly set to their safe production values. Sponsor delivery mode
must also be explicit (`exact upstream`, `bundled`, or `off`) so a stale remote
`off` secret cannot silently change the shipped banner/license behavior.
Optional authority and OAuth state remains explicit when disabled: extra-admin
and product-OAuth use the exact lowercase `off` sentinel, while JWT-rotation
and Notion-OAuth credentials stay empty. EdgeBase then overwrites retained
Worker secrets instead of silently inheriting an older deployment's authority.

Email REST credentials and passkey relying-party settings are also declared
explicitly, including as empty values when their feature is disabled. This
prevents an older remote secret from silently re-enabling either capability.
`HANJI_NOTION_IMPORT_JOB_RETENTION_DAYS` must be an integer from 1 through 365;
the documented release value and the runtime fail-safe default are 14 days.

Production browser builds use the page's own origin for `/api` and `/admin`.
Strict preflight rejects every `VITE_*` value in the release environment and
in Vite files loaded by production (`.env`, `.env.local`, `.env.production`,
and `.env.production.local`), so a stale developer endpoint cannot redirect a
published browser bundle to another backend.

Strict provenance also requires a clean public Git worktree and a full
`HANJI_BUILD_SHA` equal to that checkout's `HEAD`. Uncommitted public changes
therefore fail by design. The environment file's source URL must identify that
same full object ID in its path.

## Source and license links

Every Hanji screen includes a persistent source and license notice. The runtime
keeps upstream, revision-pinned fallbacks for local development and recovery,
but the strict release/deploy gate does not treat an implicit fallback as
release-ready. Every deployment must explicitly set all three values. A
qualifying stock build may point them at the reachable upstream revision; a
modified deployment must point them at the exact Corresponding Source and
matching license texts for the build it is running:

```bash
HANJI_BUILD_SHA=0123456789abcdef0123456789abcdef01234567
HANJI_SOURCE_URL=https://source.example/releases/0123456789abcdef0123456789abcdef01234567
HANJI_AGPL_LICENSE_URL=https://source.example/releases/0123456789abcdef0123456789abcdef01234567/LICENSE
HANJI_SPONSOR_EXCEPTION_URL=https://source.example/releases/0123456789abcdef0123456789abcdef01234567/LICENSE-EXCEPTION
```

The hostnames above are documentation placeholders and must be replaced.
Invalid, private, credential-bearing, or non-HTTPS values are never exposed to
the browser and fall back at runtime, but they fail the strict release gate.
That gate resolves every hostname, rejects private/special-use addresses and
unsafe redirects, then performs bounded `HEAD` and range `GET` requests. It
rejects stalled or empty bodies, duplicate final redirect destinations, and
license/exception responses that lack their expected AGPL/exception markers.
Run the offline structural check freely during development; run the strict
network check before a release or deploy:

```bash
npm --prefix backend run preflight:release
npm --prefix backend run preflight:release:strict
```

`npm --prefix backend run preflight:deploy` uses the same strict check before
calling EdgeBase deploy, so a production typo or a private/unpublished source
repository cannot silently advertise a dead legal link.
The production validator also rejects every active pre-Hanji environment
variable name, even when an equivalent `HANJI_*` value is present. Runtime
read compatibility remains available for upgrades, but a new release must use
only the canonical deployment namespace.
Distributors should also keep the bundled `LICENSE`, `LICENSE-EXCEPTION`, and
`SOURCE-OFFER` files with Docker or portable-pack artifacts. This is operational
guidance, not legal advice; the custom exception should be reviewed by counsel.

## Email on hosted Cloudflare Workers

The tracked Wrangler configuration declares the exact `EMAIL` Workers
`send_email` binding, and strict preflight accepts binding-only delivery only
when that static declaration is present and
`HANJI_CLOUDFLARE_EMAIL_BINDING=EMAIL`. A different binding name needs the
Cloudflare REST account/token pair instead. Local, Docker, and packed runtimes
always use REST delivery — see
[development.md](development.md#email-delivery).

That static proof does not prove the Cloudflare account is ready to deliver
mail. Before public release:

1. Use Cloudflare DNS and onboard the sender domain under Email Service → Email
   Sending; wait for its MX/SPF/DKIM/DMARC records to verify. See Cloudflare's
   [Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/)
   and [domain verification](https://developers.cloudflare.com/email-service/configuration/domains/).
2. Confirm the account plan matches the audience. Cloudflare currently permits
   sends to verified destination addresses on all plans, while arbitrary
   recipients require Workers Paid; see the official
   [Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/).
3. On the deployed release, request a password reset for a real external test
   mailbox, receive the message, open its same-origin fragment link, complete
   the reset, and verify the token cannot be reused. This live smoke is a
   release prerequisite: preflight proves only binding/config shape, not domain
   onboarding, plan entitlement, suppression state, or real deliverability.

## Deployment verification

To verify the deployable EdgeBase app surfaces without human visual review:

```bash
npm --prefix backend run verify:deployment
```

That rebuilds the SPA, verifies the local EdgeBase package links, checks the
EdgeBase app bundle, a temporary portable directory pack runtime, hosted
deploy dry-run bundle, Docker image/context, and a temporary Docker runtime
with SPA fallback routes for `/`, `/settings`, `/trash`, `/p/:id`,
`/database/:id`, `/workspace/:slug`, and `/share/:id`. If Docker is
unavailable, use `node scripts/deployment-verify.mjs --skip-docker` to verify
the pack runtime and hosted deploy dry-run output only.

## Tearing down Cloudflare resources

To remove every Cloudflare resource a deployment created, see
[cloudflare-teardown.md](cloudflare-teardown.md).
