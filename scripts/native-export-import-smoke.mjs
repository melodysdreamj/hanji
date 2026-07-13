#!/usr/bin/env node
// Native Hanji export/import round-trip smoke.
//
// Builds a source workspace with two databases joined by a dual relation, plus
// a rollup and a formula, exports it as a native `.hanji.json` document, then
// imports that document into a SECOND user's workspace and verifies every
// high-fidelity detail the CSV importer cannot carry survives the round-trip:
// relation values (remapped to the new row ids), the reciprocal back-relation,
// rollup recomputation, and formula recomputation. This is the end-to-end proof
// for backend/functions/import-export.ts native actions + lib/native-document.ts.

import {
  finalizeRegisteredSmokeAccounts,
  permanentlyDeletePage,
  assert,
  assertRuntimeReachable,
  callFunction,
  DEFAULT_BASE_URL,
  normalizeBaseUrl,
  setDefaultTimeoutMs,
  signIn,
} from './lib/harness.mjs';

const options = parseArgs(process.argv.slice(2));
setDefaultTimeoutMs(options.timeoutMs);

const created = { source: [], imported: [] };
let sourceToken = '';
let importToken = '';
let baseUrl = '';

try {
  await main();
  console.log('\nPASS native export/import round-trip preserves relations, rollups, and formulas.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL native export/import smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first (node scripts/refresh-edgebase-dev.mjs).');
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => console.error(`WARN cleanup failed: ${error?.message ?? error}`));
  await finalizeRegisteredSmokeAccounts('native export/import smoke');
}

async function main() {
  baseUrl = normalizeBaseUrl(options.url);
  console.log(`Native export/import smoke target: ${baseUrl}`);
  await assertRuntimeReachable(baseUrl);

  // ── Source workspace (user A) ──
  const owner = await signIn(baseUrl);
  sourceToken = owner.token;
  const w1 = (await callFunction(baseUrl, sourceToken, 'workspace-bootstrap', {}))?.workspace?.id;
  assert(w1, 'source workspace bootstrap must return a workspace id');

  const suffix = String(options.stamp);
  const projectsDb = await createDatabase(sourceToken, w1, `NX Projects ${suffix}`, 1);
  const tasksDb = await createDatabase(sourceToken, w1, `NX Tasks ${suffix}`, 2);
  created.source.push(projectsDb.id, tasksDb.id);

  const projectsTitleProp = titlePropId(projectsDb);
  const ids = {
    projTasksRel: uuid(),
    projEstimateSum: uuid(),
    taskEstimate: uuid(),
    taskProjectRel: uuid(),
    taskProjectNameRollup: uuid(),
    taskEstimateDoubled: uuid(),
  };

  await callFunction(baseUrl, sourceToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      { id: ids.projTasksRel, databaseId: projectsDb.id, name: 'Tasks', type: 'relation', config: { relationDatabaseId: tasksDb.id }, position: 2 },
      { id: ids.taskEstimate, databaseId: tasksDb.id, name: 'Estimate', type: 'number', config: {}, position: 2 },
      { id: ids.taskProjectRel, databaseId: tasksDb.id, name: 'Project', type: 'relation', config: { relationDatabaseId: projectsDb.id }, position: 3 },
    ],
  });
  await callFunction(baseUrl, sourceToken, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      {
        id: ids.projEstimateSum,
        databaseId: projectsDb.id,
        name: 'Estimate sum',
        type: 'rollup',
        config: { rollupRelationPropertyId: ids.projTasksRel, rollupTargetPropertyId: ids.taskEstimate, rollupFunction: 'sum' },
        position: 3,
      },
      {
        id: ids.taskProjectNameRollup,
        databaseId: tasksDb.id,
        name: 'Project name',
        type: 'rollup',
        config: { rollupRelationPropertyId: ids.taskProjectRel, rollupTargetPropertyId: projectsTitleProp, rollupFunction: 'show_original' },
        position: 4,
      },
      {
        id: ids.taskEstimateDoubled,
        databaseId: tasksDb.id,
        name: 'Estimate doubled',
        type: 'formula',
        config: { formula: 'prop("Estimate") * 2' },
        position: 5,
      },
    ],
  });

  const projectRow = (await callFunction(baseUrl, sourceToken, 'database-row-mutation', {
    action: 'create',
    id: uuid(),
    databaseId: projectsDb.id,
    title: 'Launch project',
  }))?.row;
  assert(projectRow?.id, 'source project row must be created');

  const taskRow = (await callFunction(baseUrl, sourceToken, 'database-row-mutation', {
    action: 'create',
    id: uuid(),
    databaseId: tasksDb.id,
    title: 'Draft launch plan',
    properties: { [ids.taskEstimate]: 5, [ids.taskProjectRel]: [projectRow.id] },
  }))?.row;
  assert(taskRow?.id, 'source task row must be created');
  console.log('PASS built a source workspace with a dual relation, rollup, and formula.');

  // ── Export ──
  const exported = await callFunction(baseUrl, sourceToken, 'import-export', {
    action: 'exportWorkspaceNative',
    workspaceId: w1,
  });
  const document_ = exported?.document;
  assert(document_?.format === 'hanji.export', 'export must produce an hanji.export document');
  assert((exported?.counts?.databases ?? 0) >= 2, `export must include both databases (got ${exported?.counts?.databases})`);
  assert(document_.files?.included === false, 'native export must exclude files');
  assert(
    Array.isArray(document_.relationPairs) && document_.relationPairs.length >= 1,
    'export must record the dual-relation pairing explicitly',
  );
  console.log(`PASS exported workspace: ${JSON.stringify(exported.counts)}.`);

  // ── Import into a second user's workspace ──
  const other = await signIn(baseUrl);
  importToken = other.token;
  const w2 = (await callFunction(baseUrl, importToken, 'workspace-bootstrap', {}))?.workspace?.id;
  assert(w2 && w2 !== w1, 'second user must get a distinct workspace');

  const importResult = await callFunction(baseUrl, importToken, 'import-export', {
    action: 'importNative',
    workspaceId: w2,
    document: document_,
  });
  assert((importResult?.counts?.databases ?? 0) >= 2, 'import must create both databases');
  assert(Array.isArray(importResult?.rootPageIds) && importResult.rootPageIds.length >= 1, 'import must return root page ids');
  console.log(`PASS imported into a fresh workspace: ${JSON.stringify(importResult.counts)}.`);

  // ── Verify high-fidelity survival in the imported copy ──
  const importedProjects = await findImportedDatabase(importToken, importResult.rootPageIds, 'Estimate sum');
  const importedTasks = await findImportedDatabase(importToken, importResult.rootPageIds, 'Estimate doubled');
  assert(importedProjects, 'imported Projects database must be found by its rollup property');
  assert(importedTasks, 'imported Tasks database must be found by its formula property');

  const tasksProps = importedTasks.props;
  const projectsProps = importedProjects.props;
  const importedTaskRows = await callFunction(baseUrl, importToken, 'page-query', {
    action: 'databaseRows',
    databaseId: importedTasks.id,
    pageId: importedTasks.id,
    includeComputed: true,
  });
  const importedProjectRows = await callFunction(baseUrl, importToken, 'page-query', {
    action: 'databaseRows',
    databaseId: importedProjects.id,
    pageId: importedProjects.id,
    includeComputed: true,
  });

  const taskRowNew = (importedTaskRows.rows ?? []).find((row) => row.title === 'Draft launch plan');
  const projectRowNew = (importedProjectRows.rows ?? []).find((row) => row.title === 'Launch project');
  assert(taskRowNew, 'imported task row must exist');
  assert(projectRowNew, 'imported project row must exist');

  // 1) Relation value remapped to the NEW project row id (not the source id).
  const taskRelation = idArray(taskRowNew.properties?.[tasksProps.Project]);
  assert(
    taskRelation.includes(projectRowNew.id) && !taskRelation.includes(projectRow.id),
    `imported task relation must point at the new project row id (got ${JSON.stringify(taskRelation)})`,
  );

  // 2) Reciprocal back-relation preserved on the project side.
  const projectRelation = idArray(projectRowNew.properties?.[projectsProps.Tasks]);
  assert(
    projectRelation.includes(taskRowNew.id),
    `imported reciprocal relation must include the new task row id (got ${JSON.stringify(projectRelation)})`,
  );

  // 3) Rollup recomputes across the imported relation.
  const projectNameRollup = importedTaskRows.computed?.[taskRowNew.id]?.[tasksProps['Project name']];
  assert(
    projectNameRollup?.value === 'Launch project',
    `imported rollup must recompute to the related title (got ${JSON.stringify(projectNameRollup)})`,
  );
  const estimateSumRollup = importedProjectRows.computed?.[projectRowNew.id]?.[projectsProps['Estimate sum']];
  assert(
    estimateSumRollup?.value === 5,
    `imported numeric rollup must recompute across the relation (got ${JSON.stringify(estimateSumRollup)})`,
  );

  // 4) Formula recomputes (proves the name-based expression survived the remap).
  const doubled = importedTaskRows.computed?.[taskRowNew.id]?.[tasksProps['Estimate doubled']];
  assert(doubled?.value === 10, `imported formula must recompute (got ${JSON.stringify(doubled)})`);

  console.log('PASS relation remap, reciprocal sync, rollup, and formula all survived the round-trip.');
}

async function createDatabase(token, workspaceId, title, position) {
  const id = uuid();
  const result = await callFunction(baseUrl, token, 'database-mutation', {
    action: 'createDatabase',
    id,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title,
    position,
    seedRows: false,
  });
  assert(result?.page?.id === id, `database ${title} must be created`);
  return { id, properties: result.properties ?? [] };
}

function titlePropId(db) {
  const prop = (db.properties ?? []).find((item) => item.type === 'title');
  assert(prop?.id, 'created database must expose a title property');
  return prop.id;
}

async function findImportedDatabase(token, rootIds, markerPropName) {
  for (const rootId of rootIds) {
    let db;
    try {
      db = await callFunction(baseUrl, token, 'page-query', { action: 'database', databaseId: rootId, pageId: rootId });
    } catch {
      continue; // root is a plain page, not a database
    }
    const props = db?.properties ?? [];
    if (props.some((prop) => prop.name === markerPropName)) {
      const byName = {};
      for (const prop of props) byName[prop.name] = prop.id;
      return { id: rootId, props: byName };
    }
  }
  return null;
}

function idArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)];
}

async function cleanup() {
  for (const id of created.source) {
    if (sourceToken) await permanentlyDeletePage(baseUrl, sourceToken, id).catch(() => {});
  }
  for (const id of created.imported) {
    if (importToken) await permanentlyDeletePage(baseUrl, importToken, id).catch(() => {});
  }
}

function uuid() {
  return crypto.randomUUID();
}

function parseArgs(args) {
  const parsed = { url: process.env.HANJI_EDGEBASE_URL ?? DEFAULT_BASE_URL, timeoutMs: 12_000, stamp: Date.now() };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/native-export-import-smoke.mjs [--url <url>] [--timeout-ms <n>]');
      process.exit(0);
    }
    if (arg === '--url') {
      parsed.url = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--timeout-ms') {
      parsed.timeoutMs = Number(args[i + 1]);
      i += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}
