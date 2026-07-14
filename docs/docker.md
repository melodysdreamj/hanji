# Docker quick start

The published Hanji image is the recommended installation path for Docker
Desktop, a Linux Docker host, and container-capable NAS products. It starts
without a source checkout, environment file, or terminal setup code.

For Synology-specific screens, HTTPS reverse proxy, certificates, and
WebSocket settings, use the separate
[Synology DSM visual guide](deployment.md#synology-setup-wireframes).

## Image and platform

Use the immutable release tag:

```text
melodysdreamj/hanji:0.1.0-alpha.3
```

The Docker Hub image supports Linux AMD64 and ARM64. Docker selects the correct
platform automatically. The moving `alpha` tag follows the newest alpha;
`latest` is intentionally unavailable until a stable release exists.

Container releases publish the same verified multi-platform digest to Docker
Hub and `ghcr.io/melodysdreamj/hanji` in one release workflow. Publication is
accepted only after both registries expose matching AMD64/ARM64 manifests to an
anonymous client.

## Docker Desktop or another container UI

1. Pull `melodysdreamj/hanji:0.1.0-alpha.3` from Docker Hub.
2. Create a container and enable automatic restart.
3. Publish an unused host port to container `8787/TCP`. On a personal computer,
   host port `8787` is the simplest choice.
4. For durable, easy-to-find storage, map a named volume or dedicated host
   folder to container path `/data` with read/write access.
5. Leave the image's environment variables unchanged. In particular, the
   container normally remains on internal HTTP; a NAS or reverse proxy provides
   public HTTPS.
6. Start the container and open `http://localhost:<host-port>`.

Leaving the volume screen empty is valid for evaluation: the image declares
`/data`, so Docker creates an anonymous persistent volume. It survives
stop/start and restart, but its generated name is harder to identify, back up,
and reattach when replacing the container.

## One-command installation

This command keeps the service local to the computer and stores all persistent
state in the named volume `hanji-data`:

```bash
docker run -d \
  --name hanji \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v hanji-data:/data \
  melodysdreamj/hanji:0.1.0-alpha.3
```

Open [http://localhost:8787](http://localhost:8787). The first browser visit
creates the server administrator using name, email, and password fields. There
is no installation code to retrieve from the container log. Keep a fresh
instance private until the administrator is created because the first visitor
can claim it.

Useful checks:

```bash
docker ps --filter name=hanji
docker logs --tail 100 hanji
curl http://127.0.0.1:8787/api/health
```

Stop and start the same container without losing data:

```bash
docker stop hanji
docker start hanji
```

## Data and backup

Everything that must survive container replacement lives under `/data`:

- pages, databases, and workspace state
- uploaded files
- generated session, encryption, service, and MCP secrets
- first-administrator setup completion

Back up the whole volume or mapped directory as one unit. For the named volume
used above, this creates a compressed backup in the current directory:

```bash
docker run --rm \
  -v hanji-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.22 \
  tar -C /data -czf /backup/hanji-data-backup.tar.gz .
```

Do not delete `hanji-data` during an update. A host-directory mapping may be
used instead, for example `-v /srv/hanji:/data`; it must be dedicated to Hanji
and writable by the container.

## Updating the image

Back up `/data`, then pull the new immutable tag and recreate only the
replaceable container. The named volume remains intact:

```bash
HANJI_VERSION=0.1.0-alpha.3 # replace with the new immutable release tag
docker pull "melodysdreamj/hanji:$HANJI_VERSION"
docker rm -f hanji
docker run -d \
  --name hanji \
  --restart unless-stopped \
  -p 127.0.0.1:8787:8787 \
  -v hanji-data:/data \
  "melodysdreamj/hanji:$HANJI_VERSION"
```

Use the previous immutable tag with the same `hanji-data` volume to roll back
the container image. Restore a data backup as well if a future release changes
the persisted data format incompatibly.

## HTTPS and remote access

The registry image listens on HTTP port `8787` inside the container. That is
correct for local Docker Desktop access. For access from another computer or
the internet:

- keep the mapped HTTP port private
- terminate HTTPS at a trusted reverse proxy
- forward the original `Host` and `X-Forwarded-Proto: https` headers
- enable WebSocket forwarding for realtime features
- expose only the public HTTPS port through the router/firewall

Do not change the container to HTTPS merely because the proxy uses HTTPS.
Normal password login behind a standard HTTPS reverse proxy needs no Hanji
environment-variable changes. Passkeys and other origin-sensitive advanced
features may require explicit public-origin settings; see
[Ingress and HTTPS](deployment.md#ingress-and-https-docker--pack).

Synology users should continue with the
[Synology DSM visual guide](deployment.md#synology-setup-wireframes).

## Building from source

Building an image from a source checkout is a development and audit path, not
required for normal installation:

```bash
git clone https://github.com/melodysdreamj/hanji && cd hanji
npm --prefix backend install && npm --prefix web install
bash scripts/selfhost-docker.sh up --build
```

The source helper supplies local HTTPS and supports `status`, `logs`, and
`down`. See [Local development](development.md) and
[Deployment](deployment.md) for advanced configuration and verification.
