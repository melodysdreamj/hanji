# Hanji Web

Vite + React SPA frontend for Hanji, a local-first Notion-style workspace.
This package owns the browser UI: the sidebar, page editor, comments, updates,
database views, templates, search, trash, and responsive layout.

## Run

Start the local backend first:

```sh
cd ../backend
npm install
npm run dev
```

Then start the web app:

```sh
cd ../web
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in (email
one-time code, magic link, password, or passkey). Anonymous guest bootstrap is
opt-in for local development only: it requires `VITE_ALLOW_ANONYMOUS_BOOTSTRAP`
on the web build and `NOTIONLIKE_ALLOW_DEV_GUEST_LOGIN` on the backend, and the
backend accepts it from loopback addresses only (see the root README).

## MCP

The full MCP server lives in the sibling `mcp/` package. It can read and edit the
same local workspace through the backend REST API.

```sh
cd ../mcp
npm install
node src/index.mjs
```

For client registration and the complete tool list, see
[`../mcp/README.md`](../mcp/README.md).

## Verify

```sh
npx tsc --noEmit
npm run lint
npm run build
```

## Notes

- The app uses the EdgeBase `app` database block defined in
  `../backend/edgebase.config.ts`.
- `npm run build` emits a static SPA bundle to `dist/`. The backend's
  EdgeBase `frontend` config serves this directory with SPA fallback enabled.
- The UI stores page bodies as ordered blocks and database rows as pages with
  `parentType: "database"`, matching the root project architecture.
- Environment override: set `VITE_EDGEBASE_URL` when the backend is not running
  on `http://localhost:8787`. Production builds default to the current origin.
