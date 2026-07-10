#!/usr/bin/env node
// Offline workspace-DO restore/verify helper (docs/workspace-do-migration.md).
//
// Modes:
//   restore  — replay existing dumps into each workspace DO via chunked
//              /transact, backfill the central routing indexes, then verify
//              counts + checksums.
//   verify   — re-run the restore verification only.
//
//   node scripts/workspace-do-migrate.mjs restore
//   node scripts/workspace-do-migrate.mjs verify
//
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_URL = (process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT_DIR = process.env.NOTIONLIKE_MIGRATION_DIR ?? join(root, '.edgebase', 'workspace-do-migration');
const SERVICE_KEY = process.env.SERVICE_KEY ?? readDevServiceKey();
const TIMEOUT_MS = 60_000;
const TRANSACT_CHUNK = 400;

// Content tables in dependency-safe restore order (pages first so triggers
// and FK-free lookups resolve; everything else is independent).
const CONTENT_TABLES = [
  'pages',
  'blocks',
  'comments',
  'db_properties',
  'db_property_indexes',
  'db_views',
  'db_templates',
  'page_permissions',
  'share_links',
  'collaboration_operations',
  'collaboration_documents',
  'file_uploads',
  'notion_import_connections',
  'notion_import_jobs',
  'notion_import_items',
  'notion_import_mappings',
  'change_log',
];

const mode = process.argv[2];
if (!['restore', 'verify'].includes(mode ?? '')) {
  console.error('Usage: node scripts/workspace-do-migrate.mjs <restore|verify>');
  process.exit(1);
}

try {
  if (mode === 'restore') await restore({ verifyAfter: true });
  if (mode === 'verify') await verifyRestore(loadManifest());
  console.log(`\nPASS workspace-do-migrate ${mode}`);
} catch (error) {
  console.error(`\nFAIL workspace-do-migrate ${mode}: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}

function readDevServiceKey() {
  try {
    const env = readFileSync(join(root, 'backend', '.env.development'), 'utf8');
    const line = env.split('\n').find((entry) => entry.startsWith('SERVICE_KEY='));
    return line ? line.slice('SERVICE_KEY='.length).trim() : undefined;
  } catch {
    return undefined;
  }
}

async function api(path, init = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-EdgeBase-Service-Key': SERVICE_KEY ?? '',
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
    if (response.status === 429 && attempt < 8) {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      throw new Error(`${path} HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return body;
  }
}

function checksum(rows) {
  const hash = createHash('sha256');
  for (const id of rows.map((row) => row.id).sort()) hash.update(String(id));
  return hash.digest('hex').slice(0, 16);
}

function manifestPath() { return join(OUT_DIR, 'manifest.json'); }
function loadManifest() { return JSON.parse(readFileSync(manifestPath(), 'utf8')); }

async function transactChunks(pathPrefix, operations) {
  for (let i = 0; i < operations.length; i += TRANSACT_CHUNK) {
    await api(`${pathPrefix}/transact`, {
      method: 'POST',
      body: JSON.stringify({ operations: operations.slice(i, i + TRANSACT_CHUNK) }),
    });
  }
}

async function restore({ verifyAfter }) {
  if (!SERVICE_KEY) throw new Error('SERVICE_KEY missing.');
  const manifest = loadManifest();

  // Guard: restores must land in the workspace block. Probe by counting a
  // content table centrally — split-only runtimes have no central 'pages'
  // table and error.
  let splitMode = false;
  try {
    await api('/api/db/app/tables/pages/count');
  } catch {
    splitMode = true;
  }
  if (!splitMode) {
    throw new Error('Runtime still exposes central content tables; restore requires the split-only schema.');
  }

  // Preserved workspace last (contract: touch it only after the process has
  // proven itself on the others). Match by NOTIONLIKE_PRESERVED_WORKSPACE_HINT.
  const preservedHint = (process.env.NOTIONLIKE_PRESERVED_WORKSPACE_HINT ?? '').toLowerCase();
  const ordered = [...manifest.workspaces].sort((a, b) => {
    const preserved = (w) =>
      preservedHint && (w.name ?? '').toLowerCase().includes(preservedHint) ? 1 : 0;
    return preserved(a) - preserved(b);
  });

  for (const meta of ordered) {
    const tables = JSON.parse(readFileSync(join(OUT_DIR, `workspace-${meta.workspaceId}.json`), 'utf8'));
    const prefix = `/api/db/workspace/${meta.workspaceId}`;
    console.log(`Restoring workspace ${meta.workspaceId} (${meta.name ?? 'unnamed'})...`);
    for (const table of CONTENT_TABLES) {
      const rows = tables[table] ?? [];
      if (!rows.length) continue;
      const existing = await api(`${prefix}/tables/${table}/count`).then((r) => r?.total ?? 0).catch(() => 0);
      if (existing >= rows.length) {
        console.log(`  ${table}: ${existing} already present, skipping`);
        continue;
      }
      await transactChunks(prefix, rows.map((row) => ({ table, op: 'insert', data: row })));
      console.log(`  ${table}: inserted ${rows.length}`);
    }
  }

  console.log('Backfilling central routing indexes...');
  const indexOps = [];
  for (const meta of manifest.workspaces) {
    const tables = JSON.parse(readFileSync(join(OUT_DIR, `workspace-${meta.workspaceId}.json`), 'utf8'));
    for (const page of tables.pages ?? []) {
      indexOps.push({ table: 'page_workspace_index', op: 'insert', data: { id: page.id, workspaceId: meta.workspaceId } });
    }
    for (const link of tables.share_links ?? []) {
      indexOps.push({
        table: 'share_link_index',
        op: 'insert',
        data: { id: link.id, token: link.token, workspaceId: meta.workspaceId, pageId: link.pageId, enabled: link.enabled === true },
      });
    }
    for (const permission of tables.page_permissions ?? []) {
      indexOps.push({
        table: 'page_permission_index',
        op: 'insert',
        data: {
          id: permission.id,
          workspaceId: meta.workspaceId,
          pageId: permission.pageId,
          principalType: permission.principalType,
          principalId: permission.principalType === 'email'
            ? String(permission.principalId ?? permission.label ?? '').trim().toLowerCase()
            : permission.principalId,
        },
      });
    }
  }
  // Index tables may partially exist from trigger activity during restore;
  // tolerate per-chunk unique-conflict failures by falling back to row-wise.
  for (let i = 0; i < indexOps.length; i += TRANSACT_CHUNK) {
    const chunk = indexOps.slice(i, i + TRANSACT_CHUNK);
    try {
      await api('/api/db/app/transact', { method: 'POST', body: JSON.stringify({ operations: chunk }) });
    } catch {
      for (const op of chunk) {
        await api('/api/db/app/transact', { method: 'POST', body: JSON.stringify({ operations: [op] }) }).catch(() => {});
      }
    }
  }
  console.log(`  index rows: ${indexOps.length}`);

  if (verifyAfter) await verifyRestore(manifest);
}

async function verifyRestore(manifest) {
  console.log('Verifying restored workspaces against the manifest...');
  const failures = [];
  for (const meta of manifest.workspaces) {
    const tables = JSON.parse(readFileSync(join(OUT_DIR, `workspace-${meta.workspaceId}.json`), 'utf8'));
    const prefix = `/api/db/workspace/${meta.workspaceId}`;
    for (const table of CONTENT_TABLES) {
      const expected = meta.tables[table];
      if (!expected?.count) continue;
      const count = await api(`${prefix}/tables/${table}/count`).then((r) => r?.total ?? 0);
      if (count !== expected.count) {
        failures.push(`${meta.workspaceId}/${table}: count ${count} != ${expected.count}`);
        continue;
      }
      // Checksum over restored ids (paged reads).
      const ids = [];
      for (let page = 1; page <= 200; page += 1) {
        const res = await api(`${prefix}/tables/${table}?page=${page}&perPage=1000`);
        const items = res?.items ?? [];
        ids.push(...items.map((item) => item.id));
        if (items.length < 1000) break;
      }
      const digest = checksum(ids.map((id) => ({ id })));
      if (digest !== expected.checksum) {
        failures.push(`${meta.workspaceId}/${table}: checksum ${digest} != ${expected.checksum}`);
      }
    }
    console.log(`  workspace ${meta.workspaceId}: ok so far`);
  }
  if (failures.length) {
    throw new Error(`verification failures:\n- ${failures.join('\n- ')}`);
  }
  console.log('All workspace counts and checksums match the dump manifest.');
}
