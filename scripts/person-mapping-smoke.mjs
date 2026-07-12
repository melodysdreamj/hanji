#!/usr/bin/env node
// Imported-person mapping smoke (API-level): seeds a workspace with a
// database row person value and a person mention span that both reference an
// imported `notion-user:*` identity, then maps them onto a real workspace
// member through the person-mapping function and verifies the rewrite.
import {
  assert,
  assertRuntimeReachable,
  normalizeBaseUrl,
  resolveUrl,
  masterCredentials,
} from './lib/harness.mjs';
import { randomUUID } from 'node:crypto';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const { email: MASTER_EMAIL, password: MASTER_PASSWORD } = masterCredentials();

async function api(path, body, token) {
  const response = await fetch(resolveUrl(BASE, path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

async function signin(email, password) {
  const { status, json } = await api('/api/auth/signin', { email, password });
  assert(status === 200, `signin ${email} failed with ${status}`);
  return json.accessToken ?? json.session?.accessToken;
}

async function main() {
  await assertRuntimeReachable(BASE);
  const suffix = Date.now();
  const master = await signin(MASTER_EMAIL, MASTER_PASSWORD);

  // Workspace + member that the imported identity will map onto.
  const memberEmail = `mapped-target-${suffix}@example.com`;
  const created = await api(
    '/api/functions/instance-admin',
    { action: 'createUser', email: memberEmail, displayName: `Mapped Target ${suffix}` },
    master,
  );
  assert(created.status === 200, `createUser failed: ${JSON.stringify(created.json).slice(0, 160)}`);
  const targetUserId = (created.json.users ?? []).find((user) => user.email === memberEmail)?.id;
  assert(targetUserId, 'created user id should be listed');

  const ws = await api(
    '/api/functions/workspace-mutation',
    { action: 'createWorkspace', name: `Person mapping ${suffix}`, skipDefaultPages: true },
    master,
  );
  const workspaceId = ws.json.workspace?.id;
  assert(workspaceId, 'workspace should be created');
  const invited = await api(
    '/api/functions/workspace-mutation',
    { action: 'inviteMember', workspaceId, userId: targetUserId, email: memberEmail, role: 'member' },
    master,
  );
  assert(invited.status === 200, `inviteMember by userId failed: ${JSON.stringify(invited.json).slice(0, 160)}`);

  // Seed imported references: one row person value + one block mention span.
  const importedRef = {
    id: `notion-user:${suffix}`,
    userId: `notion-user:${suffix}`,
    notionUserId: String(suffix),
    displayName: 'Imported Kim',
    email: memberEmail,
    notion: { object: 'user', name: 'Imported Kim' },
  };
  const databaseId = randomUUID();
  const assigneePropId = randomUUID();
  const rowId = randomUUID();
  const pageId = randomUUID();
  const blockId = randomUUID();
  // Database rows are created through database-row-mutation and validated
  // against the schema, so the person property must exist first. Create the
  // database with an explicit "Assignee" person property.
  const dbPage = await api('/api/functions/database-mutation', {
    action: 'createDatabase',
    id: databaseId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title: 'Mapping DB',
    viewType: 'table',
    properties: [
      { id: randomUUID(), name: 'Name', type: 'title', position: 1 },
      { id: assigneePropId, name: 'Assignee', type: 'person', position: 2 },
    ],
  }, master);
  assert(dbPage.status === 200, `database create failed: ${JSON.stringify(dbPage.json).slice(0, 160)}`);
  const row = await api('/api/functions/database-row-mutation', {
    action: 'create',
    id: rowId,
    workspaceId,
    databaseId,
    title: 'Row with imported person',
    properties: { [assigneePropId]: [importedRef] },
  }, master);
  assert(row.status === 200, `row create failed: ${JSON.stringify(row.json).slice(0, 160)}`);
  const docPage = await api('/api/functions/page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: 'Mention page',
    position: 2,
  }, master);
  assert(docPage.status === 200, 'doc page create failed');
  const block = await api('/api/functions/block-mutation', {
    action: 'create',
    id: blockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: {
      rich: [
        { text: 'Ping ' },
        {
          text: '@Imported Kim',
          mention: 'person',
          userId: importedRef.userId,
          notionUser: importedRef,
        },
      ],
    },
    plainText: 'Ping @Imported Kim',
    position: 1,
  }, master);
  assert(block.status === 200, `block create failed: ${JSON.stringify(block.json).slice(0, 160)}`);

  // list: the imported identity shows up with the email-matched suggestion.
  const listed = await api('/api/functions/person-mapping', { action: 'list', workspaceId }, master);
  assert(listed.status === 200, `person-mapping list failed: ${JSON.stringify(listed.json).slice(0, 160)}`);
  const entry = (listed.json.people ?? []).find((person) => person.sourceId === importedRef.userId);
  assert(entry, 'imported person should be listed');
  assert(entry.propertyValueCount >= 1 && entry.mentionCount >= 1, `usage counts should register, got ${JSON.stringify(entry)}`);
  assert(entry.suggestedUserId === targetUserId, 'email match should suggest the workspace member');
  console.log('PASS person-mapping list surfaces the imported identity with an email suggestion.');

  // Guard: mapping to a non-member is rejected.
  const denied = await api('/api/functions/person-mapping', {
    action: 'apply',
    workspaceId,
    mappings: { [importedRef.userId]: 'not-a-member' },
  }, master);
  assert(denied.status === 400, `non-member mapping should 400, got ${denied.status}`);
  console.log('PASS mapping targets are restricted to workspace members.');

  const applied = await api('/api/functions/person-mapping', {
    action: 'apply',
    workspaceId,
    mappings: { [importedRef.userId]: targetUserId },
  }, master);
  assert(applied.status === 200, `apply failed: ${JSON.stringify(applied.json).slice(0, 160)}`);
  assert(applied.json.changedPages >= 1 && applied.json.changedBlocks >= 1, `apply should rewrite both surfaces: ${JSON.stringify(applied.json)}`);

  const rowAfter = await api('/api/functions/page-query', { action: 'page', pageId: rowId }, master);
  const value = rowAfter.json.page?.properties?.[assigneePropId];
  assert(Array.isArray(value) && value[0] === targetUserId, `row person value should be the mapped userId, got ${JSON.stringify(value)}`);

  const blocksAfter = await api('/api/functions/page-query', { action: 'blocks', pageId }, master);
  const span = (blocksAfter.json.blocks ?? [])
    .flatMap((item) => (Array.isArray(item.content?.rich) ? item.content.rich : []))
    .find((item) => item.mention === 'person');
  assert(span?.userId === targetUserId, `mention span should be mapped, got ${JSON.stringify(span)}`);
  assert(span?.notionUser?.userId === importedRef.userId, 'provenance should keep the source identity');

  const relisted = await api('/api/functions/person-mapping', { action: 'list', workspaceId }, master);
  assert(
    !(relisted.json.people ?? []).some((person) => person.sourceId === importedRef.userId),
    'mapped identity should disappear from the list',
  );
  console.log('PASS apply rewrites row values and mention spans, keeps provenance, and clears the list.');

  await api('/api/functions/workspace-mutation', { action: 'deleteWorkspace', workspaceId }, master).catch(() => {});
  console.log('PASS person mapping flow works end to end.');
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL person mapping smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
