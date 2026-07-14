# Master Account

Every Hanji deployment starts with one master account, which is also the first
instance administrator. A fresh dev, Docker, or Cloudflare runtime normally
creates it in the first-run web installer; the operator does not preconfigure
the administrator email or password.

## Browser first-run installer

Open a fresh Hanji runtime and choose the administrator name, email, password,
and password confirmation in the browser. Dev and Docker require no setup code.
Cloudflare's deploy command generates a private setup capability, syncs it as a
Worker secret, and prints a setup link after deploy. The capability travels in
the URL fragment, is removed from browser history before the first request, and
is then sent only in a dedicated request header. It is never entered into the
form.

The server records a durable setup claim before creating the auth account, so
concurrent setup requests cannot create two masters. A same-email retry can
recover if the process stopped between auth creation and app-database
finalization. Public signup stays fenced until the master/admin record is
complete.

Like traditional wiki installers, the first browser visitor can claim a fresh
dev or Docker instance. Keep a new container on a private LAN or unexposed
reverse-proxy route until setup is complete. A public Cloudflare visitor without
the private deploy link sees only the normal sign-in screen and cannot create
the first administrator. The successful claim permanently closes the installer,
including after Docker replacement with the same `/data` volume.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `HANJI_BROWSER_SETUP` | Enables browser first-run setup. The normal dev, Docker, and Cloudflare paths set this automatically. |
| `HANJI_BROWSER_SETUP_TOKEN` | Optional private hosted-setup capability. `npm --prefix backend run deploy` generates and preserves it in the ignored `.env.release`; Docker and dev do not need it. |
| `HANJI_MASTER_EMAIL` | Legacy noninteractive compatibility. When set with `HANJI_MASTER_PASSWORD`, provisions an unused email without the browser installer. |
| `HANJI_MASTER_PASSWORD` | Legacy noninteractive compatibility. Used only for the initial account creation and never reapplied after later password changes. |

Normal installations leave both `HANJI_MASTER_*` values empty. They remain for
legacy migrations and advanced automation that deliberately bypasses the web
installer. Passing a literal compatibility password as a shell argument would
leave it in shell history; use an environment file or secret manager instead.

## Behavior

- **Browser first boot**: `instance-bootstrap` records the single-winner claim,
  creates the submitted account through trusted admin authority, promotes it into
  `instance_settings.instanceAdminUserIds`, records the ensure in
  `instance_audit_events` (`instance.master.bootstrap`), and caches
  `masterUserId`/`masterEmail` in `instance_settings`. Client signup stays
  blocked until that identity is confirmed.
- **Compatibility env boot**: the same endpoint idempotently provisions the
  configured legacy master pair. An ordinary account with that email is never
  promoted. Provisioning fails closed and logs the collision; choose a new,
  unused master email (or use an already-confirmed master identity) and retry.
- **Dev**: `node scripts/setup-dev-env.mjs` generates only runtime secrets and
  enables browser setup. It removes retired stored master credentials from the
  ignored dev env files. Open the fresh runtime and create the account there.
- **Docker**: the image enables un-tokened browser setup internally and keeps
  the first-visitor/private-network rule described above.
- **Cloudflare**: `npm --prefix backend run deploy` prepares the private setup
  capability before strict preflight and prints the fragment-only link only
  after a successful deploy. Strict release validation accepts browser setup
  without `HANJI_MASTER_*` and rejects a missing or weak hosted capability.
- **CI**: managed jobs call `completeSetup` with synthetic credentials after the
  runtime becomes healthy. The credentials are test data, not product defaults.

## Rotating credentials

- **Password (self-service)**: sign in as master → Account Security →
  password change form. The env value is not consulted after creation.
- **Password (forgotten)**: restart is not enough (env password only applies
  at creation). Use another instance admin's Server console
  (`resetUserPassword` issues a temporary password and revokes sessions), or
  the EdgeBase admin path where applicable.
- **Email**: use the account settings/admin workflow. Changing the legacy
  `HANJI_MASTER_EMAIL` still provisions another administrator for compatibility,
  but is not the normal rotation path.

## Security notes

- Environment bootstrap never trusts caller identity. Dev/Docker browser setup
  is open only while the instance has no account. Public hosted setup additionally
  requires the private deploy capability. Both rely on the durable claim to
  close the window permanently.
- The legacy `HANJI_INSTANCE_ADMIN_EMAILS` and
  `EDGEBASE_INSTANCE_ADMIN_EMAILS` allowlists are ignored and rejected by
  release preflight because password-signup emails are unverified. Bootstrap
  additional administrators only by immutable auth user ID; the master account
  itself is created by the server.
