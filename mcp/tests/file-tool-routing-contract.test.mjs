import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
const notionRegistrySource = await readFile(
  new URL('../src/tool-registry-notion.mjs', import.meta.url),
  'utf8',
);
const databaseRegistrySource = await readFile(
  new URL('../src/tool-registry-database.mjs', import.meta.url),
  'utf8',
);
const edgebaseSource = await readFile(new URL('../src/edgebase.mjs', import.meta.url), 'utf8');
const liveSmokeSource = await readFile(new URL('../scripts/live-smoke.mjs', import.meta.url), 'utf8');

test('file delete/download tools require deterministic workspace routing', () => {
  assert.match(notionRegistrySource, /"delete_file"[\s\S]*workspaceId: z\.string\(\)\.optional\(\)/);
  assert.match(notionRegistrySource, /"create_file_download_url"[\s\S]*workspaceId: z\.string\(\)\.optional\(\)/);
  assert.match(
    notionRegistrySource,
    /Provide a workspace-qualified key, or provide both workspaceId and uploadId\./,
  );
  assert.doesNotMatch(liveSmokeSource, /callTool\("delete_file", \{ uploadId \}/);
});

test('live file smoke uploads and finalizes bytes before delete/download checks', () => {
  assert.match(notionRegistrySource, /"complete_file_upload"/);
  assert.match(liveSmokeSource, /const uploadForm = new FormData\(\)/);
  assert.match(liveSmokeSource, /uploadForm\.append\("file", new Blob/);
  assert.match(liveSmokeSource, /uploadForm\.append\("customMetadata"/);
  assert.match(liveSmokeSource, /method: "POST"/);
  assert.match(liveSmokeSource, /callTool\("complete_file_upload", \{ uploadId, key: uploadKey \}\)/);
  assert.match(
    liveSmokeSource,
    /callTool\("delete_file", \{ workspaceId, uploadId \}\)/,
  );
});

test('prepare/list route block, property, and template-only targets through the current workspace', () => {
  assert.match(
    notionRegistrySource,
    /"prepare_file_upload"[\s\S]*templateId: z\.string\(\)\.optional\(\)/,
  );
  assert.match(
    notionRegistrySource,
    /"list_files"[\s\S]*templateId: z\.string\(\)\.optional\(\)/,
  );
  assert.match(
    notionRegistrySource,
    /"prepare_file_upload"[\s\S]*const routedWorkspaceId = workspaceId \|\| \(await eb\.workspace\(\)\)\.id;/,
  );
  assert.match(
    notionRegistrySource,
    /"list_files"[\s\S]*const routedWorkspaceId = workspaceId \|\| \(await eb\.workspace\(\)\)\.id;/,
  );
  assert.match(notionRegistrySource, /prepareFileUpload\(\{[\s\S]*blockId,[\s\S]*propertyId,[\s\S]*templateId,/);
  assert.match(notionRegistrySource, /listFiles\(\{[\s\S]*blockId,[\s\S]*propertyId,[\s\S]*templateId,/);
});

test('permanent page and row deletes retain a workspace retry anchor', () => {
  assert.match(
    indexSource,
    /eb\.del\("pages", pageId, \{ workspaceId: root\.workspaceId \}\)/,
  );
  assert.match(
    databaseRegistrySource,
    /eb\.deleteDatabaseRow\(rowId, \{[\s\S]*databaseId: row\.parentId,[\s\S]*workspaceId: row\.workspaceId,/,
  );
  assert.match(
    edgebaseSource,
    /body: \{ action: "delete", id, workspaceId: opts\.workspaceId \}/,
  );
  assert.match(
    edgebaseSource,
    /async deleteDatabaseRow\(rowId, opts = \{\}\)[\s\S]*databaseId: opts\.databaseId,[\s\S]*workspaceId: opts\.workspaceId,/,
  );
});
