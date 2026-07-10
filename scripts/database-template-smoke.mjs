#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let workspaceId = '';
let databaseId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database template smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`WARN cleanup failed: ${message}`);
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Database template smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  const suffix = Date.now();
  databaseId = crypto.randomUUID();
  const createdDatabase = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'database',
    title: `Template smoke ${suffix}`,
    position: suffix,
  });
  assert(createdDatabase?.page?.id === databaseId, 'owner must be able to create a template smoke database');

  const textPropertyId = crypto.randomUUID();
  const checkboxPropertyId = crypto.randomUUID();
  const uniquePropertyId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      {
        id: textPropertyId,
        databaseId,
        name: 'Notes',
        type: 'rich_text',
        config: {},
        position: 1,
      },
      {
        id: checkboxPropertyId,
        databaseId,
        name: 'Ready',
        type: 'checkbox',
        config: {},
        position: 2,
      },
      {
        id: uniquePropertyId,
        databaseId,
        name: 'Task ID',
        type: 'unique_id',
        config: { prefix: 'TSK' },
        position: 3,
      },
    ],
  });

  const defaultTemplateId = crypto.randomUUID();
  const explicitTemplateId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insertMany',
    table: 'db_templates',
    records: [
      {
        id: defaultTemplateId,
        databaseId,
        name: 'Default task',
        icon: '🌱',
        title: 'Default task title',
        properties: {
          [textPropertyId]: 'Default template notes',
          [checkboxPropertyId]: true,
          [uniquePropertyId]: 999,
        },
        blocks: [
          {
            type: 'paragraph',
            content: { rich: [{ text: 'Default template body' }] },
            children: [
              {
                type: 'to_do',
                content: { rich: [{ text: 'Nested template task' }], checked: false },
              },
            ],
          },
        ],
        isDefault: true,
        position: 1,
      },
      {
        id: explicitTemplateId,
        databaseId,
        name: 'Explicit task',
        icon: '📌',
        title: 'Explicit task title',
        properties: {
          [textPropertyId]: 'Explicit template notes',
          [checkboxPropertyId]: false,
        },
        blocks: [
          {
            type: 'heading_2',
            content: { rich: [{ text: 'Explicit template body' }] },
          },
        ],
        isDefault: false,
        position: 2,
      },
    ],
  });

  const defaultRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
  });
  assert(defaultRow?.row?.title === 'Default task title', 'default template must supply row title');
  assert(defaultRow.row.icon === '🌱', 'default template must supply row icon');
  assert(defaultRow.row.properties?.[textPropertyId] === 'Default template notes', 'default template must apply rich text properties');
  assert(defaultRow.row.properties?.[checkboxPropertyId] === true, 'default template must apply checkbox properties');
  assert(defaultRow.row.properties?.[uniquePropertyId] === 1, 'unique_id must be generated instead of copied from a template');
  assert(Array.isArray(defaultRow.blocks) && defaultRow.blocks.length === 2, 'default template must insert nested body blocks');
  const defaultRootBlock = defaultRow.blocks.find((block) => block.parentId == null);
  const defaultChildBlock = defaultRow.blocks.find((block) => block.parentId === defaultRootBlock?.id);
  assert(defaultRootBlock?.plainText === 'Default template body', 'default template root block must be inserted');
  assert(defaultChildBlock?.plainText === 'Nested template task', 'default template child block must be inserted');
  console.log('PASS default database templates apply title, icon, properties, unique IDs, and body blocks.');

  const emptyRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    title: 'Manual empty row',
    templateId: '',
  });
  assert(emptyRow?.row?.title === 'Manual empty row', 'empty row creation must keep explicit title');
  assert(emptyRow.row.properties?.[textPropertyId] === undefined, 'empty row must skip default text properties');
  assert(emptyRow.row.properties?.[checkboxPropertyId] === undefined, 'empty row must skip default checkbox properties');
  assert(emptyRow.row.properties?.[uniquePropertyId] === 2, 'empty row must still receive generated unique_id');
  assert(Array.isArray(emptyRow.blocks) && emptyRow.blocks.length === 0, 'empty row must not insert template blocks');
  console.log('PASS empty database rows bypass the default template while preserving generated properties.');

  const explicitRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    templateId: explicitTemplateId,
    properties: {
      [checkboxPropertyId]: true,
    },
  });
  assert(explicitRow?.row?.title === 'Explicit task title', 'explicit template must supply row title');
  assert(explicitRow.row.icon === '📌', 'explicit template must supply row icon');
  assert(explicitRow.row.properties?.[textPropertyId] === 'Explicit template notes', 'explicit template must apply properties');
  assert(explicitRow.row.properties?.[checkboxPropertyId] === true, 'input properties must override template defaults');
  assert(explicitRow.row.properties?.[uniquePropertyId] === 3, 'explicit template rows must receive the next generated unique_id');
  assert(
    Array.isArray(explicitRow.blocks) &&
      explicitRow.blocks.length === 1 &&
      explicitRow.blocks[0].plainText === 'Explicit template body',
    'explicit template must insert its body blocks',
  );
  console.log('PASS explicit database templates apply defaults and allow property overrides.');

  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    properties: {
      [uniquePropertyId]: 999,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    templateId: crypto.randomUUID(),
  }, 404);
  console.log('PASS row creation rejects direct read-only values and unknown templates.');

  console.log('\nPASS database template row creation works through product APIs.');
}

async function cleanup() {
  if (!owner?.token || !databaseId) return;
  const baseUrl = normalizeBaseUrl(options.url);
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'delete',
    id: databaseId,
  }).catch(() => {});
}

function parseArgs(args) {
  const parsed = {
    url: DEFAULT_BASE_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = resolveValue(args, i, arg);
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(resolveValue(args, i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function resolveValue(args, index, label) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node scripts/database-template-smoke.mjs [options]

Checks database row template creation, default template application, explicit
template application, empty row creation, and read-only property protection
against a running Notionlike EdgeBase runtime.

Options:
  --url <url>             Runtime URL. Defaults to NOTIONLIKE_EDGEBASE_URL or http://127.0.0.1:8787.
  --timeout-ms <number>   Per-request timeout. Defaults to ${DEFAULT_TIMEOUT_MS}.
`);
}

async function assertRuntimeReachable(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/health'), {
    headers: { Accept: 'application/json' },
  });
  assert(response.ok, `/api/health returned HTTP ${response.status}`);
}

async function signIn(baseUrl) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin/anonymous'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `anonymous sign-in returned HTTP ${response.status}`);
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'anonymous sign-in must return an access token');
  assert(typeof userId === 'string' && userId, 'anonymous sign-in must return a user id');
  return { token, userId };
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(
      `${name} returned HTTP ${response.status} for ${JSON.stringify(body).slice(0, 300)}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function expectFunctionStatus(baseUrl, token, name, body, status) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(`${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function postFunction(baseUrl, token, name, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, `/api/functions/${name}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}: ${text.slice(0, 200)}`);
  }
}

async function fetchWithTimeout(url, init) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(options.timeoutMs),
  });
}

function normalizeBaseUrl(value) {
  const parsed = new URL(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/, '');
}

function resolveUrl(baseUrl, path) {
  return new URL(path, `${baseUrl}/`).toString();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
