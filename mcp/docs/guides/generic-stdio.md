# Generic stdio client

How to wire the Hanji MCP server into any MCP client that can launch a local
stdio server. This is the full command/args/env contract; the other guides are
client-specific packagings of the same thing.

## Prerequisites

- Node.js 22.12 or newer (`mcp/package.json` `engines`), with `npm install`
  run once in `mcp/`.
- A running Hanji backend — `npm run dev` in `backend/`, reachable at
  `http://localhost:8787` by default.
- An EdgeBase access token (see [Getting a token](#getting-a-token)).

## Contract

- **Transport**: stdio only. The client spawns the process and speaks MCP over
  stdin/stdout; there is no HTTP/SSE endpoint today.
- **Command**: `node`
- **Args**: `["/path/to/hanji/mcp/src/index.mjs"]` (absolute path)
- **Env**: all configuration is environment variables — matching MCP
  authorization guidance for local stdio servers. No CLI flags.

| Variable | Purpose |
| --- | --- |
| `HANJI_EDGEBASE_URL` | Backend base URL (default `http://127.0.0.1:8787`) |
| `HANJI_MCP_ACCESS_TOKEN` | EdgeBase bearer token (raw or `Bearer ...`) |
| `HANJI_MCP_AUTH_MODE` | Set to `token` to require a token and fail fast |
| `HANJI_MCP_ALLOW_ANONYMOUS` | Set to `false` to disable anonymous bootstrap |
| `HANJI_MCP_READ_ONLY` | Set to `true` to refuse all mutating tools |
| `HANJI_MCP_POLICY_FILE` | Path to a JSON policy file (read-only, allowlists, scopes) |

Token env variables are checked in this order: `HANJI_MCP_ACCESS_TOKEN`,
`HANJI_EDGEBASE_ACCESS_TOKEN`, then `EDGEBASE_ACCESS_TOKEN`.

A typical client config (adapt the key names to your client):

```json
{
  "command": "node",
  "args": ["/path/to/hanji/mcp/src/index.mjs"],
  "env": {
    "HANJI_EDGEBASE_URL": "http://localhost:8787",
    "HANJI_MCP_AUTH_MODE": "token",
    "HANJI_MCP_ACCESS_TOKEN": "YOUR_TOKEN"
  }
}
```

Sanity-check outside any client with:

```bash
HANJI_EDGEBASE_URL=http://localhost:8787 node /path/to/hanji/mcp/src/index.mjs
```

The process waits silently for MCP messages on stdin; that is the healthy state.

## Getting a token

Today, use the access token of a signed-in EdgeBase user: copy the bearer token
from an authenticated session against your backend (for local development, the
token the Hanji web app holds after sign-in). One-click token issuance from the
Hanji Settings UI is planned; until then this manual copy is the supported
path.

For local experiments only, you may omit the token and `HANJI_MCP_AUTH_MODE`
entirely — the server falls back to anonymous bootstrap. Deployed or multi-user
setups should always set `HANJI_MCP_AUTH_MODE=token` and
`HANJI_MCP_ALLOW_ANONYMOUS=false`, one process per user or service
principal.

## Read-only mode

Set `HANJI_MCP_READ_ONLY=true` (or its alias
`HANJI_MCP_ALLOW_WRITES=false`), or point `HANJI_MCP_POLICY_FILE` at
a JSON file containing `{"readOnly": true, ...}` plus optional allowlists and
scopes — see the [access policy section of the README](../../README.md#access-policy).
Env flags can only narrow a policy file, never widen it. Ask the
`get_mcp_access_policy` tool to inspect the active policy.

## Troubleshooting

- **Backend unreachable** (`fetch failed` / `ECONNREFUSED` in tool errors): the
  backend is not running or `HANJI_EDGEBASE_URL` points at the wrong port.
  Start `npm run dev` in `backend/` and confirm the URL (default
  `http://127.0.0.1:8787`).
- **Anonymous fallback refused**: with `HANJI_MCP_AUTH_MODE=token` or
  `HANJI_MCP_ALLOW_ANONYMOUS=false`, the server fails fast when no token
  is configured. Provide a token in one of the accepted env variables, or drop
  those flags for local anonymous bootstrap.
- **Token expired** (401/unauthorized errors on every tool call): EdgeBase
  tokens expire; copy a fresh token from a signed-in session, update the env,
  and restart the server process from your client.
