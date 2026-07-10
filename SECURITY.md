# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. The project does not
yet publish versioned production releases, so older commits are not supported.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not
open a public issue with exploit details, credentials, personal data, or a proof
of concept that targets a live system.

Include the affected route or component, impact, reproduction conditions, and
any suggested mitigation. Maintainers will acknowledge a complete report as
soon as practical and coordinate disclosure after a fix and regression guard
are available.

## Deployment baseline

Before exposing an instance publicly:

1. Copy `backend/.env.release.example` to the ignored `.env.release` file.
2. Replace every required placeholder and run `npm --prefix backend run preflight:deploy`.
3. Run the unit, build, packaging, and live-runtime verification gates.
4. Verify unauthenticated raw database routes return HTTP 403.
5. Serve the SPA and API over HTTPS on the same origin so the Strict,
   host-only HttpOnly refresh cookie retains its intended boundary. Do not add
   wildcard credentialed CORS origins.
6. Run the backend behind network egress filtering that blocks loopback,
   RFC1918, link-local, and cloud-metadata ranges (for example
   `169.254.169.254`). The URL-metadata and import fetchers validate literals
   and re-resolve DNS defensively, but a fast DNS-rebinding window remains on
   platforms whose `fetch()` re-resolves independently — egress filtering is
   the outer defense the guard is designed to pair with.
7. Keep EdgeBase, Node.js, GitHub Actions, and browser-test dependencies current.

Never commit `.env.release`, service keys, JWT secrets, OAuth secrets, Notion
tokens, exported workspace data, or production database snapshots.
