FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

ARG HANJI_BUILD_SHA=unknown

# workerd requires glibc, so use Debian slim instead of Alpine. Keep npm pinned
# to a release that removes the fixable HIGH findings bundled by the base image.
# The runtime invokes Wrangler directly and does not install an unused pnpm CLI.
# Workerd uses the system trust store for outbound HTTPS requests such as the
# Notion API, so the otherwise-minimal image must retain the public CA bundle.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@12.0.1 && \
    npm install -g wrangler@4.103.0

WORKDIR /app

# `edgebase docker build` creates this portable app bundle before invoking
# Docker, then copies it into a synthetic build context.
COPY .edgebase/targets/docker-app/ ./

RUN addgroup --system --gid 10001 edgebase && \
    adduser --system --uid 10001 --ingroup edgebase --home /home/edgebase edgebase

RUN mkdir -p /data /home/edgebase/.config && \
    chown -R edgebase:edgebase /app /data /home/edgebase

# Registry-pulled images do not run the EdgeBase CLI's secret generator. Keep
# an appliance-owned secret set inside the persistent /data volume instead.
# JSON parsing avoids sourcing operator-controlled shell text. Existing env
# values are imported on the first upgraded start, then a mismatch fails closed
# so removing an old env-file cannot silently rotate sessions/encryption keys.
COPY edgebase-entrypoint.mjs /usr/local/bin/edgebase-entrypoint.mjs

ENV PORT=8787
ENV HOST=0.0.0.0
ENV PERSIST_DIR=/data
ENV WRANGLER_CONFIG=wrangler.toml
ENV LOCAL_PROTOCOL=http
ENV EDGEBASE_UID=10001
ENV EDGEBASE_GID=10001
ENV HOME=/home/edgebase
ENV HANJI_BUILD_SHA=$HANJI_BUILD_SHA

VOLUME ["/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "const s=process.env.LOCAL_PROTOCOL==='https';const p=s?require('https'):require('http');const r=p.get('http'+(s?'s':'')+'://localhost:'+process.env.PORT+'/api/health',s?{rejectUnauthorized:false}:{},x=>{process.exit(x.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.setTimeout(3000,()=>process.exit(1));"

# The entrypoint starts as root only long enough to prepare a dedicated /data
# bind mount, then permanently drops to the fixed edgebase uid/gid before it
# reads secrets or starts Wrangler. This keeps named volumes and NAS bind mounts
# usable without running the application server as root.
USER root

CMD ["node", "/usr/local/bin/edgebase-entrypoint.mjs"]
