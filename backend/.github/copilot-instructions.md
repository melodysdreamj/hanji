<!-- edgebase:ai-hints:start -->
# EdgeBase Copilot Instructions

- Use the installed `edgebase` skill for EdgeBase-specific work when it is available.
- Inspect `edgebase.config.ts`, `functions/`, and the imported `@edge-base/*` package before generating code.
- Choose the SDK by trust boundary:
  - browser or other untrusted client -> client/web SDK
  - trusted backend with Service Keys -> admin SDK
  - server code acting as the current cookie-authenticated user -> SSR SDK
- Prefer installed `llms.txt` files under `node_modules/@edge-base/*/llms.txt` and `node_modules/create-edgebase/llms.txt` over guessed package surfaces.
- Never place service keys in shipped client code.
<!-- edgebase:ai-hints:end -->
