# Claude Desktop

Register the Hanji MCP server with the Claude Desktop app via its
`claude_desktop_config.json`.

## Prerequisites

- Node.js 22.12 or newer (`mcp/package.json` `engines`), with `npm install`
  run once in `mcp/`.
- A running Hanji backend — `npm run dev` in `backend/`, reachable at
  `http://localhost:8787` by default.
- An EdgeBase access token (see [Getting a token](#getting-a-token)).

## Configuration

Edit the config file (create it if missing):

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "hanji": {
      "command": "node",
      "args": ["/path/to/hanji/mcp/src/index.mjs"],
      "env": {
        "HANJI_EDGEBASE_URL": "http://localhost:8787",
        "HANJI_MCP_AUTH_MODE": "token",
        "HANJI_MCP_ACCESS_TOKEN": "YOUR_TOKEN"
      }
    }
  }
}
```

Replace `/path/to/hanji` with the absolute path to this repository, then
fully restart Claude Desktop. The Hanji tools appear under the tools icon in
the chat input.

Claude Desktop launches MCP servers with a minimal environment, so keep all
configuration in the `env` block — shell profile exports are not inherited. If
`node` is not on the app's PATH (common with nvm/fnm), use an absolute path
such as `/usr/local/bin/node` or the output of `which node` as `command`.

## Getting a token

Today, use the access token of a signed-in EdgeBase user: copy the bearer token
from an authenticated session against your backend (for local development, the
token the Hanji web app holds after sign-in). Raw tokens and `Bearer ...`
strings are both accepted, checked in this order: `HANJI_MCP_ACCESS_TOKEN`,
`HANJI_EDGEBASE_ACCESS_TOKEN`, `EDGEBASE_ACCESS_TOKEN`. One-click token
issuance from the Hanji Settings UI is planned; until then this manual copy is
the supported path.

For local experiments only, you may omit the token and `HANJI_MCP_AUTH_MODE`
entirely — the server falls back to anonymous bootstrap.

## Read-only mode

Add to the `env` block:

```json
"HANJI_MCP_READ_ONLY": "true"
```

Or point at a durable policy file with
`"HANJI_MCP_POLICY_FILE": "/secure/policy.json"` containing
`{"readOnly": true, ...}`. Env flags can only narrow a policy file, never widen
it. Ask the `get_mcp_access_policy` tool to inspect the active policy.

## Troubleshooting

- **Backend unreachable** (`fetch failed` / `ECONNREFUSED` in tool errors): the
  backend is not running or `HANJI_EDGEBASE_URL` points at the wrong port.
  Start `npm run dev` in `backend/` and confirm the URL (default
  `http://127.0.0.1:8787`).
- **Anonymous fallback refused**: with `HANJI_MCP_AUTH_MODE=token` or
  `HANJI_MCP_ALLOW_ANONYMOUS=false`, the server fails fast when no token
  is configured, and Claude Desktop shows the server as failed. Provide a token
  in one of the accepted env variables, or drop those flags for local anonymous
  bootstrap.
- **Token expired** (401/unauthorized errors on every tool call): EdgeBase
  tokens expire; copy a fresh token from a signed-in session, update the config,
  and restart Claude Desktop. MCP server logs live under
  `~/Library/Logs/Claude/mcp*.log` on macOS if you need details.
