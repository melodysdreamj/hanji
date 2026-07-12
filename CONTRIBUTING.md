# Contributing

Thanks for your interest in improving Hanji.

## Development setup

Prerequisites: Node.js ≥ 22.12 and npm.

```bash
npm --prefix backend install
npm --prefix web install
npm --prefix mcp install
```

Run the stack in three terminals — see
[docs/development.md](docs/development.md) for the full walkthrough:

```bash
npm --prefix backend run dev   # EdgeBase backend on :8787
npm --prefix web run dev       # Vite SPA on :3000
node mcp/src/index.mjs         # optional: MCP server (stdio)
```

## Before you open a pull request

Run the fast gates for every package you touched:

```bash
npm --prefix backend run test && npm --prefix backend run typecheck && npm --prefix backend run lint
npm --prefix web run test && npm --prefix web run lint && npx --prefix web tsc --noEmit
npm --prefix mcp run typecheck && npm --prefix mcp run lint && npm --prefix mcp test
npm run verify:namespace && npm run test:namespace
```

Before a release-oriented change, also build the web app and scan the generated
bundle (`npm --prefix web run build && npm run verify:namespace:generated`).
Only the centralized read-compatibility payload is permitted to retain an old
namespace; new settings, storage, headers, URIs, docs, and generated output use
Hanji names.

CI additionally runs live API smokes and Playwright UI smokes from `scripts/`
against a real dev runtime. If your change affects a user-visible flow, run the
matching `npm --prefix backend run verify:*` script locally when you can — the
full catalog is in [docs/verification.md](docs/verification.md).

Guidelines:

- Keep changes small and focused; avoid drive-by refactors.
- Bug fixes should come with a regression test (unit test where the logic is
  pure; smoke coverage for user-visible flows).
- New smoke scripts under `scripts/` must import the shared helpers from
  `scripts/lib/harness.mjs` instead of copying sign-in/browser boilerplate.
- Match the surrounding code style; both TypeScript packages gate on ESLint
  (including strict react-hooks rules in `web/`).

## Reporting issues

Use the issue templates. For security problems, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.

## License and the CLA

Hanji is [GNU AGPL-3.0](LICENSE) with the
[Sponsor Banner Exception 2.0](LICENSE-EXCEPTION), and may also be offered under
separate terms (including the commercial, banner-free license referenced in the
[README](README.md#license)).

Because of that, first-time contributors are asked to sign the
[Contributor License Agreement](docs/CLA.md) — a one-time step: a bot comments on
your pull request, and you sign by replying once. The CLA grants the project a
broad license to use and **relicense** your contribution (including under
commercial terms) while **you keep the copyright to your own work**.

Only submit material you have the authority to license this way. If your employer
owns rights to what you create, get their permission first.
