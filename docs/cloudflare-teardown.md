# Cloudflare Teardown (`edgebase destroy`)

How to remove every project-scoped Cloudflare resource that a `npx edgebase
deploy` of this backend creates. Verified against the local EdgeBase CLI
implementation (`$EDGEBASE_REPO/packages/cli/src/commands/destroy.ts`)
and a live `--dry-run` in this repo on 2026-07-10.

## What gets destroyed for this project

Resource names come from `backend/wrangler.toml` plus the deploy manifest
(`backend/.edgebase/cloudflare-deploy-manifest.json`, written by `deploy`):

| Resource | Concrete name / binding | How it is deleted |
| --- | --- | --- |
| Worker | `hanji-backend` | `wrangler delete hanji-backend --force` |
| Durable Objects | `DatabaseDO`, `AuthDO`, `DatabaseLiveDO`, `RoomsDO`, `LogsDO` (bindings `DATABASE`, `AUTH`, `DATABASE_LIVE`, `ROOMS`, `LOGS`) | Deleted together with the Worker (`--force` removes DO classes and all DO SQLite storage) |
| R2 bucket | `hanji-backend-storage` (binding `STORAGE`) | Managed-storage wipe via the Worker admin API, then `wrangler r2 bucket delete` |
| D1 database | `hanji-backend-auth` (binding `AUTH_DB`) | Cloudflare D1 API by id when the manifest has one, else `wrangler d1 delete` by managed name |
| D1 database | `hanji-backend-control` (binding `CONTROL_DB`) | Same as above |
| KV namespace | binding `KV` (managed name `internal`) | `wrangler kv namespace delete` by id from the manifest, else by name candidates (`KV`, `internal`, `hanji-backend-KV`) |

Notes on discovery:

- `destroy` merges the deploy manifest with `wrangler.toml`. It works even
  when no manifest exists (the current state of this repo — see below), but a
  manifest gives it real Cloudflare ids instead of name-based guessing, so
  prefer destroying from the same checkout that deployed.
- The placeholder ids in `wrangler.toml` (`id = "local"`,
  `database_id = "local"`) are recognized as placeholders and ignored;
  deletion then falls back to name-based lookup.
- Only `managed: true` resources are touched. The CLI also knows how to
  remove Turnstile widgets, Vectorize indexes, and Hyperdrive configs, but
  this project defines none.
- All Hanji workspace/page/block data lives in the Durable Objects'
  SQLite storage, so the Worker deletion step is the one that erases product
  data — not just compute.

### R2 managed-storage wipe detail

For the `STORAGE` bucket, destroy first calls the deployed Worker's admin
endpoint (`POST /admin/api/backup/restore-storage?action=wipe`, authenticated
with the root Service Key) to empty the bucket, because Cloudflare refuses to
delete a non-empty bucket. If the bulk wipe fails and the bucket is not
empty, it falls back to listing and deleting objects one by one through
`/admin/api/data/storage/buckets/...`. Both paths need the Worker to still be
alive, which is why destroy deletes the bucket **before** the Worker and will
skip Worker deletion if the bucket delete failed (deleting the Worker first
would strand a non-empty bucket).

## Recommended sequence

```bash
cd backend

# 1. Confirm what deploy recorded (may be absent if never deployed here)
cat .edgebase/cloudflare-deploy-manifest.json

# 2. Preview the deletion plan — safe, deletes nothing, needs no credentials
npx edgebase destroy --dry-run

# 3. Review the printed plan (worker + R2 + D1 x2 + KV expected for this repo)

# 4. Execute
EDGEBASE_URL=https://<worker-url> \
EDGEBASE_SERVICE_KEY=<root-service-key> \
CLOUDFLARE_API_TOKEN=<token> \
CLOUDFLARE_ACCOUNT_ID=<account-id> \
npx edgebase destroy --yes
```

Without `--yes`, an interactive terminal gets a `y/N` confirmation prompt; in
non-interactive/JSON mode the CLI stops with a structured
`destroy_confirmation_required` (`needs_input`) issue instead of deleting
anything.

On a fully successful (non-dry-run) destroy, the CLI also removes the local
state files `backend/.edgebase/cloudflare-deploy-manifest.json`,
`backend/.edgebase/secrets.json`, and `backend/edgebase-schema.lock.json`.

## Required credentials

| Variable / flag | Needed for |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Non-interactive destroy; D1 deletion by id and Turnstile deletion always use the API token. Interactive terminals may use the wrangler OAuth login instead. |
| `CLOUDFLARE_ACCOUNT_ID` | Account scoping when the manifest has no (or a placeholder) account id. |
| `EDGEBASE_URL` or `--url` | Worker URL for the managed `STORAGE` wipe. Falls back to the manifest's recorded worker URL. |
| `EDGEBASE_SERVICE_KEY` or `--service-key` | Root Service Key for the storage-wipe admin endpoints. If the bucket is non-empty and these are missing, the R2 delete fails with a hint to set them. |

`--dry-run` needs no credentials at all — it never contacts Cloudflare.

## Irreversibility

**`edgebase destroy --yes` permanently deletes data. There is no undo.**

- R2: every object in `hanji-backend-storage` (all uploaded files,
  covers, attachments) is wiped and the bucket removed.
- D1: `hanji-backend-auth` (all accounts, sessions, credentials) and
  `hanji-backend-control` are dropped.
- Durable Objects: deleting the Worker with `--force` destroys all DO SQLite
  storage — i.e. every workspace, page, block, comment, notification, and
  live-collaboration state in `DatabaseDO`/`AuthDO`/`DatabaseLiveDO`/
  `RoomsDO`/`LogsDO`.

Take an export/backup (`npx edgebase backup` or the product's native export)
before destroying anything you might want back.

Failure handling is conservative: a resource that is already gone counts as
deleted ("already removed"), any other failure is reported and — in JSON
mode — surfaces as `destroy_partial_failure`; the local manifest is kept so
destroy can be re-run.

## Dry-run output in this repo (2026-07-10)

No deploy manifest exists in this checkout
(`backend/.edgebase/` contains `dev/`, `runtime/`, `secrets.json`,
`targets/`, `ui-discovery/` — no `cloudflare-deploy-manifest.json`), meaning
this tree has not performed a Cloudflare deploy. The plan below was derived
purely from `wrangler.toml`:

```
$ cd backend && npx edgebase destroy --dry-run
🧹 Previewing Cloudflare destroy...

  • Worker: hanji-backend
  • r2_bucket: hanji-backend-storage (STORAGE)
  • d1_database: auth (AUTH_DB)
  • d1_database: control (CONTROL_DB)
  • kv_namespace: internal (KV)

✓ Destroy preview complete.
  Run npx edgebase destroy --yes to execute.
(exit 0)
```

Durable Objects do not appear as separate plan lines because they are removed
implicitly with the Worker.
