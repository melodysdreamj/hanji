FROM node:26-slim@sha256:ffc78385a788964bb3cbab5e434ff79a10bdc25b8ae6db03fe5fe6cb14053c09

# workerd requires glibc, so use Debian slim instead of Alpine. Keep npm pinned
# to a release that removes the fixable HIGH findings bundled by the base image.
# The runtime invokes Wrangler directly and does not install an unused pnpm CLI.
RUN npm install -g npm@12.0.1 && npm install -g wrangler@4.103.0

WORKDIR /app

# `edgebase docker build` creates this portable app bundle before invoking
# Docker, then copies it into a synthetic build context.
COPY .edgebase/targets/docker-app/ ./

RUN addgroup --system edgebase && adduser --system --ingroup edgebase --home /home/edgebase edgebase

RUN mkdir -p /data /home/edgebase/.config && \
    chown -R edgebase:edgebase /app /data /home/edgebase

RUN { \
    echo '#!/bin/sh'; \
    echo 'set -eu'; \
    echo ''; \
    echo 'PERSIST_DIR="${PERSIST_DIR:-/data}"'; \
    echo 'HOST="${HOST:-0.0.0.0}"'; \
    echo 'PORT="${PORT:-8787}"'; \
    echo 'WRANGLER_CONFIG="${WRANGLER_CONFIG:-wrangler.toml}"'; \
    echo 'GENERATED_CONFIG_PATH="/app/.edgebase/runtime/server/src/generated-config.ts"'; \
    echo ''; \
    echo 'mkdir -p "${PERSIST_DIR}" /home/edgebase/.config'; \
    echo ''; \
    echo 'if [ -n "${EDGEBASE_CONFIG:-}" ]; then'; \
    echo '  printf "%s\n\n%s\n" "const config = ${EDGEBASE_CONFIG};" "export default config;" > "${GENERATED_CONFIG_PATH}"'; \
    echo 'fi'; \
    echo ''; \
    echo '# A .dev.vars file makes Wrangler ignore the container process environment.'; \
    echo '# Remove any bundled copy and forward all container variables, including'; \
    echo '# Hanji-specific auth, mail, OAuth, import, and admin settings.'; \
    echo 'rm -f /app/.dev.vars'; \
    echo 'export CLOUDFLARE_INCLUDE_PROCESS_ENV="${CLOUDFLARE_INCLUDE_PROCESS_ENV:-true}"'; \
    echo ''; \
    echo 'LOCAL_PROTOCOL="${LOCAL_PROTOCOL:-http}"'; \
    echo ''; \
    echo '# Serve TLS in-process when LOCAL_PROTOCOL=https so release-mode HttpOnly'; \
    echo '# cookie auth works over https://localhost without a separate TLS-terminating'; \
    echo '# proxy (self-hosted appliance model). With no cert paths Wrangler generates'; \
    echo '# a self-signed certificate; mount a persistent one via HTTPS_CERT_PATH /'; \
    echo '# HTTPS_KEY_PATH to keep a stable, OS-trustable certificate across restarts.'; \
    echo 'set -- --config "$WRANGLER_CONFIG" --port "$PORT" --ip "$HOST" --persist-to "$PERSIST_DIR" --show-interactive-dev-session=false'; \
    echo 'if [ "$LOCAL_PROTOCOL" = "https" ]; then'; \
    echo '  set -- "$@" --local-protocol https'; \
    echo '  if [ -n "${HTTPS_CERT_PATH:-}" ] && [ -n "${HTTPS_KEY_PATH:-}" ]; then'; \
    echo '    set -- "$@" --https-cert-path "$HTTPS_CERT_PATH" --https-key-path "$HTTPS_KEY_PATH"'; \
    echo '  fi'; \
    echo 'fi'; \
    echo ''; \
    echo 'cd /app'; \
    echo 'exec wrangler dev "$@"'; \
  } > /usr/local/bin/edgebase-entrypoint.sh && chmod +x /usr/local/bin/edgebase-entrypoint.sh

ENV PORT=8787
ENV HOST=0.0.0.0
ENV PERSIST_DIR=/data
ENV WRANGLER_CONFIG=wrangler.toml
ENV CLOUDFLARE_INCLUDE_PROCESS_ENV=true
ENV LOCAL_PROTOCOL=http

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const s=process.env.LOCAL_PROTOCOL==='https';const p=s?require('https'):require('http');const r=p.get('http'+(s?'s':'')+'://localhost:'+process.env.PORT+'/api/health',s?{rejectUnauthorized:false}:{},x=>{process.exit(x.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(3000,()=>process.exit(1));"

USER edgebase

CMD ["/usr/local/bin/edgebase-entrypoint.sh"]
