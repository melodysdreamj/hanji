FROM node:22-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

ARG HANJI_BUILD_SHA=unknown
ARG HANJI_IMAGE_VERSION=unknown
ARG HANJI_EDGEBASE_VERSION=0.5.0
ARG HANJI_EDGEBASE_PROVENANCE_POLICY=hanji-edgebase-npm-lock-v1

LABEL io.hanji.edgebase.version="${HANJI_EDGEBASE_VERSION}" \
      io.hanji.edgebase.provenance-policy="${HANJI_EDGEBASE_PROVENANCE_POLICY}"

# workerd requires glibc, so use Debian slim instead of Alpine. Keep npm pinned
# to a release that removes the fixable HIGH findings bundled by the base image.
# The appliance entrypoint owns loopback Wrangler, the external gateway, and
# the manifest schedule supervisor without installing an unused pnpm CLI.
# Workerd uses the system trust store for outbound HTTPS requests such as the
# Notion API, so the otherwise-minimal image must retain the public CA bundle.
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates openssl tini && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@12.0.1 && \
    npm install -g --allow-scripts=esbuild,workerd,sharp wrangler@4.114.0

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
COPY data-directory-access.mjs /usr/local/bin/data-directory-access.mjs
COPY persistence-format.mjs /usr/local/bin/persistence-format.mjs
COPY runtime-config.mjs /usr/local/bin/runtime-config.mjs
COPY selfhost-memory-limit.mjs /usr/local/bin/hanji-memory-limit.mjs

ENV PORT=8787 \
    HOST=0.0.0.0 \
    PERSIST_DIR=/data \
    WRANGLER_CONFIG=wrangler.toml \
    LOCAL_PROTOCOL=http \
    EDGEBASE_UID=10001 \
    EDGEBASE_GID=10001 \
    HOME=/home/edgebase \
    HANJI_BUILD_SHA=$HANJI_BUILD_SHA \
    HANJI_IMAGE_VERSION=$HANJI_IMAGE_VERSION

VOLUME ["/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD node -e "const s=process.env.LOCAL_PROTOCOL==='https';const p=s?require('https'):require('http');const q=x=>new Promise((v,j)=>{const r=p.get('http'+(s?'s':'')+'://localhost:'+process.env.PORT+x,s?{rejectUnauthorized:false}:{},a=>{let b='';a.setEncoding('utf8');a.on('data',c=>{b+=c;if(b.length>65536)r.destroy(new Error('health response too large'))});a.on('end',()=>v({status:a.statusCode,body:b}))});r.on('error',j);r.setTimeout(3000,()=>r.destroy(new Error('health timeout')))});Promise.all([q('/__edgebase/health'),q('/api/functions/health')]).then(([g,a])=>{const h=JSON.parse(g.body);process.exit(g.status===200&&h.schemaVersion===1&&(h.outcome==='ok'||h.outcome==='degraded')&&h.product==='proxy-ready'&&a.status===200?0:1)}).catch(()=>process.exit(1));"

# The entrypoint starts as root only long enough to probe the dedicated /data
# mount as the fixed edgebase uid/gid, then permanently drops to that identity
# before it reads secrets or starts Wrangler. Host ownership and ACL changes
# remain operator-owned rather than being applied recursively by the image.
USER root

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/usr/local/bin/edgebase-entrypoint.mjs"]
