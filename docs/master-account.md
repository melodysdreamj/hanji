# Master Account

Every Hanji deployment starts with one master account, which is also the first
instance administrator. Docker users normally create it in the first-run web
installer. Automated/hosted deployments can still provision it from the
environment.

## Docker first-run installer

A fresh Docker volume receives all runtime secrets on the container's first
start. Open Hanji and choose the administrator name, email, and password in the
browser. No container-log code or environment file is required.

The server records a durable setup claim before creating the auth account, so
concurrent setup requests cannot create two masters. A same-email retry can
recover if the process stopped between auth creation and app-database
finalization. Public signup stays fenced until the master/admin record is
complete.

Like traditional wiki installers, the first browser visitor can claim a fresh
instance. Keep the new container on a private LAN or unexposed reverse-proxy
route until setup is complete. The successful claim permanently closes the
installer, including after container replacement with the same `/data` volume.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `HANJI_MASTER_EMAIL` | Master account email. It must be unused unless `instance_settings` already confirms that exact master identity. Changing it provisions a new account on the next request (the old account keeps existing). |
| `HANJI_MASTER_PASSWORD` | Used only when the account is first created. Later password changes in Account Security are never overwritten by this value. |

Use these values for dev automation, Cloudflare, portable packs, or an advanced
Docker deployment that deliberately bypasses the web installer. Passing the literal password as a shell
argument would leave it in shell history — reference an environment variable
instead (e.g. `HANJI_MASTER_PASSWORD="$MASTER_PASSWORD"`).

## Behavior

- **First boot**: the `instance-bootstrap` endpoint (called by the web client
  on load) idempotently creates the master account, promotes it into
  `instance_settings.instanceAdminUserIds`, records the ensure in
  `instance_audit_events` (`instance.master.bootstrap`), and caches
  `masterUserId`/`masterEmail` in `instance_settings` so later requests skip
  the scan. Client signup stays blocked until that pair is confirmed, so a
  public signup cannot race the trusted admin creation and pre-claim the
  configured email.
- **Email collision**: an ordinary account with the configured email is never
  promoted. Provisioning fails closed and logs the collision; choose a new,
  unused master email (or use an already-confirmed master identity) and retry.
- **Fresh Docker instance without master env**: the image enables the browser
  first-run installer itself. When neither that image capability nor master env
  exists (for example an incompletely configured portable/hosted runtime),
  initialization still fails closed. Existing instances and loopback dev/test
  runtimes keep their prior behavior.
- **Dev**: `node scripts/setup-dev-env.mjs` asks for the master email and
  password on first setup and writes them into `backend/.dev.vars` /
  `.env.development` (no credentials are hardcoded in the repo). The dev
  runtime reads them from there, and browsers sign in through the normal
  password form. The public bootstrap endpoint never returns either value;
  request URL/Host loopback checks cannot authenticate the network peer.
  Smokes resolve credentials directly via the harness `masterCredentials()`
  helper (env → backend/.dev.vars → CI defaults).
- **Release preflight** (`npm run preflight:deploy`) requires
  `HANJI_MASTER_EMAIL`/`HANJI_MASTER_PASSWORD` in `.env.release`
  and rejects the retired `HANJI_MASTER_DEV_AUTOLOGIN` flag.

## Rotating credentials

- **Password (self-service)**: sign in as master → Account Security →
  password change form. The env value is not consulted after creation.
- **Password (forgotten)**: restart is not enough (env password only applies
  at creation). Use another instance admin's Server console
  (`resetUserPassword` issues a temporary password and revokes sessions), or
  the EdgeBase admin path where applicable.
- **Email**: change `HANJI_MASTER_EMAIL` to an unused address and restart;
  the next request provisions the new master account. The previous master
  keeps its instance-admin rights until removed in the Server console.

## Security notes

- Environment bootstrap never trusts caller identity. Browser bootstrap is
  intentionally open only while the Docker instance has no account, and relies
  on a durable single-winner claim to close that window permanently.
- The legacy `HANJI_INSTANCE_ADMIN_EMAILS` and
  `EDGEBASE_INSTANCE_ADMIN_EMAILS` allowlists are ignored and rejected by
  release preflight because password-signup emails are unverified. Bootstrap
  additional administrators only by immutable auth user ID; the master account
  itself is created by the server.
