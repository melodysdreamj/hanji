#!/usr/bin/env node

const DEFAULT_BASE_URL = process.env.NOTIONLIKE_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let workspaceId = '';
let projectDbId = '';
let taskDbId = '';
let otherDbId = '';
let customDbId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL database relation smoke: ${message}`);
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
  console.log(`Database relation smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');

  const suffix = Date.now();
  projectDbId = await createDatabase(baseUrl, `Relation smoke projects ${suffix}`, suffix);
  taskDbId = await createDatabase(baseUrl, `Relation smoke tasks ${suffix}`, suffix + 1);
  otherDbId = await createDatabase(baseUrl, `Relation smoke other ${suffix}`, suffix + 2);
  customDbId = await createDatabase(baseUrl, `Relation smoke custom ${suffix}`, suffix + 3, [
    { name: 'Task', type: 'title' },
    { name: 'Estimate', type: 'number', numberFormat: 'number' },
    { name: 'Stage', type: 'status', options: ['Todo', 'Doing', 'Done'] },
    { name: 'Estimate label', type: 'formula', formula: 'format(prop("Estimate"))' },
  ]);

  const projectNamePropId = crypto.randomUUID();
  const projectTasksPropId = crypto.randomUUID();
  const taskEstimatePropId = crypto.randomUUID();
  const taskDuePropId = crypto.randomUUID();
  const taskDonePropId = crypto.randomUUID();
  const taskProjectPropId = crypto.randomUUID();
  const taskProjectNameRollupPropId = crypto.randomUUID();
  const projectEstimateSumRollupPropId = crypto.randomUUID();
  const projectEstimateMedianRollupPropId = crypto.randomUUID();
  const projectEstimateRangeRollupPropId = crypto.randomUUID();
  const projectDonePercentRollupPropId = crypto.randomUUID();
  const projectDueRangeRollupPropId = crypto.randomUUID();
  const taskFormulaPropId = crypto.randomUUID();
  const taskDateFormulaPropId = crypto.randomUUID();
  const taskIfsFormulaPropId = crypto.randomUUID();
  const taskAdvancedFormulaPropId = crypto.randomUUID();
  const taskDateEdgeFormulaPropId = crypto.randomUUID();
  const taskDynamicDateFormulaPropId = crypto.randomUUID();

  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      {
        id: projectNamePropId,
        databaseId: projectDbId,
        name: 'Project name',
        type: 'rich_text',
        config: {},
        position: 1,
      },
      {
        id: projectTasksPropId,
        databaseId: projectDbId,
        name: 'Tasks',
        type: 'relation',
        config: { relationDatabaseId: taskDbId },
        position: 2,
      },
      {
        id: taskEstimatePropId,
        databaseId: taskDbId,
        name: 'Estimate',
        type: 'number',
        config: {},
        position: 1,
      },
      {
        id: taskProjectPropId,
        databaseId: taskDbId,
        name: 'Project',
        type: 'relation',
        config: { relationDatabaseId: projectDbId },
        position: 2,
      },
      {
        id: taskDuePropId,
        databaseId: taskDbId,
        name: 'Due',
        type: 'date',
        config: {},
        position: 3,
      },
      {
        id: taskDonePropId,
        databaseId: taskDbId,
        name: 'Done',
        type: 'checkbox',
        config: {},
        position: 4,
      },
    ],
  });

  const rollup = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskProjectNameRollupPropId,
      databaseId: taskDbId,
      name: 'Project name rollup',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: taskProjectPropId,
        rollupTargetPropertyId: projectNamePropId,
        rollupFunction: 'show_original',
      },
      position: 5,
    },
  });
  assert(rollup?.record?.id === taskProjectNameRollupPropId, 'valid rollup config must be accepted');

  const sumRollup = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: projectEstimateSumRollupPropId,
      databaseId: projectDbId,
      name: 'Task estimate sum',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: projectTasksPropId,
        rollupTargetPropertyId: taskEstimatePropId,
        rollupFunction: 'sum',
      },
      position: 3,
    },
  });
  assert(sumRollup?.record?.id === projectEstimateSumRollupPropId, 'valid numeric rollup config must be accepted');

  const advancedRollups = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insertMany',
    table: 'db_properties',
    records: [
      {
        id: projectEstimateMedianRollupPropId,
        databaseId: projectDbId,
        name: 'Task estimate median',
        type: 'rollup',
        config: {
          rollupRelationPropertyId: projectTasksPropId,
          rollupTargetPropertyId: taskEstimatePropId,
          rollupFunction: 'median',
        },
        position: 4,
      },
      {
        id: projectEstimateRangeRollupPropId,
        databaseId: projectDbId,
        name: 'Task estimate range',
        type: 'rollup',
        config: {
          rollupRelationPropertyId: projectTasksPropId,
          rollupTargetPropertyId: taskEstimatePropId,
          rollupFunction: 'range',
        },
        position: 5,
      },
      {
        id: projectDonePercentRollupPropId,
        databaseId: projectDbId,
        name: 'Task done percent',
        type: 'rollup',
        config: {
          rollupRelationPropertyId: projectTasksPropId,
          rollupTargetPropertyId: taskDonePropId,
          rollupFunction: 'percent_checked',
        },
        position: 6,
      },
      {
        id: projectDueRangeRollupPropId,
        databaseId: projectDbId,
        name: 'Task due range',
        type: 'rollup',
        config: {
          rollupRelationPropertyId: projectTasksPropId,
          rollupTargetPropertyId: taskDuePropId,
          rollupFunction: 'date_range',
        },
        position: 7,
      },
    ],
  });
  assert(advancedRollups?.records?.length === 4, 'advanced rollup configs must be accepted');

  const formula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskFormulaPropId,
      databaseId: taskDbId,
      name: 'Estimate doubled',
      type: 'formula',
      config: { formula: 'prop("Estimate") * 2' },
      position: 6,
    },
  });
  assert(formula?.record?.id === taskFormulaPropId, 'valid formula config must be accepted');
  const dateFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskDateFormulaPropId,
      databaseId: taskDbId,
      name: 'Due summary',
      type: 'formula',
      config: {
        formula:
          'concat(formatDate(dateAdd(prop("Due"), 3, "days"), "YYYY/MM/DD"), " ", format(dateBetween(dateAdd(prop("Due"), 3, "days"), prop("Due"), "days")), " ", format(year(prop("Due"))), "-", format(month(prop("Due"))), "-", format(day(prop("Due"))))',
      },
      position: 7,
    },
  });
  assert(dateFormula?.record?.id === taskDateFormulaPropId, 'valid date formula config must be accepted');
  const ifsFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskIfsFormulaPropId,
      databaseId: taskDbId,
      name: 'Done label',
      type: 'formula',
      config: { formula: 'ifs(prop("Done"), "Done", prop("Estimate") > 10, "Large", true, "Small")' },
      position: 8,
    },
  });
  assert(ifsFormula?.record?.id === taskIfsFormulaPropId, 'valid ifs formula config must be accepted');
  const advancedFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskAdvancedFormulaPropId,
      databaseId: taskDbId,
      name: 'Advanced formula summary',
      type: 'formula',
      config: {
        formula:
          'lets(base, prop("Estimate"), dueRange, prop("Due"), concat(format(min(3, base, 4)), "/", format(max(3, base, 4)), "/", format(sum(1, 2, 3)), "/", format(mean(2, 4, 6)), "/", format(median(1, 9, 3)), "/", format(pow(2, 3) + mod(10, 4) + 2 ^ 3), "/", format(round(sqrt(5), 2)), "/", format(sign(-10)), "/", format(date(parseDate("2026-06-24T13:45Z"))), "-", format(hour(parseDate("2026-06-24T13:45Z"))), "-", format(minute(parseDate("2026-06-24T13:45Z"))), "-", format(week(parseDate("2026-01-05"))), "/", dateStart(dueRange), "/", dateEnd(dueRange), "/", format(timestamp(fromTimestamp(1689024900000)))))',
      },
      position: 9,
    },
  });
  assert(advancedFormula?.record?.id === taskAdvancedFormulaPropId, 'valid advanced Notion-style formula config must be accepted');
  const dateEdgeFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskDateEdgeFormulaPropId,
      databaseId: taskDbId,
      name: 'Date edge summary',
      type: 'formula',
      config: {
        formula:
          'concat(dateAdd(parseDate("2024-01-31"), 1, "months"), "/", dateAdd(parseDate("2024-02-29"), 1, "years"), "/", dateSubtract(parseDate("2024-03-31"), 1, "months"), "/", format(dateBetween(parseDate("2024-03-31"), parseDate("2024-01-31"), "months")), "/", formatDate(parseDate("2024-02-31"), "YYYY-MM-DD"), "/", format(timestamp(parseDate("2024-02-31"))))',
      },
      position: 10,
    },
  });
  assert(dateEdgeFormula?.record?.id === taskDateEdgeFormulaPropId, 'valid date edge formula config must be accepted');
  const dynamicDateFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: taskDynamicDateFormulaPropId,
      databaseId: taskDbId,
      name: 'Current date summary',
      type: 'formula',
      config: {
        formula:
          'concat(formatDate(today(), "YYYY-MM-DD"), "/", formatDate(now(), "YYYY-MM-DD"), "/", format(timestamp(now()) >= timestamp(today())), "/", format(dateBetween(now(), today(), "hours") >= 0))',
      },
      position: 11,
    },
  });
  assert(dynamicDateFormula?.record?.id === taskDynamicDateFormulaPropId, 'valid now/today formula config must be accepted');
  console.log('PASS relation, rollup, and formula properties can be created through product APIs.');

  const updatedFormula = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'update',
    table: 'db_properties',
    id: taskFormulaPropId,
    databaseId: taskDbId,
    patch: {
      config: {
        formula:
          'if(and(startsWith(lower(trim(" Draft launch plan ")), "draft"), endsWith("launch plan", "plan"), or(false, contains("Alpha Beta", "beta")), not(empty(prop("Estimate")))), concat(upper("large"), " ", replaceAll(substring("launch plan", 0, 11), " ", "-"), " ", format(toNumber("8") + prop("Estimate")), " ", format(round(abs(-1.6))), "-", format(floor(1.9)), "-", format(ceil(1.1)), "-", format(length("ship"))), "small")',
      },
    },
  });
  assert(
    updatedFormula?.record?.config?.formula?.includes('replaceAll(substring('),
    'valid formula config updates must be accepted',
  );

  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Missing relation target',
      type: 'relation',
      config: { relationDatabaseId: crypto.randomUUID() },
      position: 99,
    },
  }, 404);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Invalid rollup relation',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: taskEstimatePropId,
        rollupFunction: 'show_original',
      },
      position: 100,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Invalid rollup function',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: taskProjectPropId,
        rollupTargetPropertyId: projectNamePropId,
        rollupFunction: 'mode',
      },
      position: 101,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Invalid formula config',
      type: 'formula',
      config: { formula: { expr: 'not a string' } },
      position: 102,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Unknown formula ref',
      type: 'formula',
      config: { formula: 'prop("Missing estimate") + 1' },
      position: 103,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId: taskDbId,
      name: 'Unsupported formula fn',
      type: 'formula',
      config: { formula: 'map(prop("Estimate"))' },
      position: 104,
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'update',
    table: 'db_properties',
    id: taskFormulaPropId,
    databaseId: taskDbId,
    patch: {
      config: { formula: 'prop(Estimate)' },
    },
  }, 400);
  console.log('PASS invalid relation, rollup, and formula configs are rejected.');

  const projectRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: projectDbId,
    title: 'Launch project',
    properties: {
      [projectNamePropId]: 'Launch project',
    },
  });
  assert(projectRow?.row?.id, 'project row must be created');

  const otherRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: otherDbId,
    title: 'Wrong database row',
  });
  assert(otherRow?.row?.id, 'other database row must be created');

  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: taskDbId,
    title: 'Blocked relation row',
    properties: {
      [taskProjectPropId]: [otherRow.row.id],
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: taskDbId,
    title: 'Blocked read-only row',
    properties: {
      [taskProjectNameRollupPropId]: 'copied rollup',
      [taskFormulaPropId]: 12,
    },
  }, 400);
  console.log('PASS row creation rejects wrong-database relations and read-only rollup/formula values.');

  const taskRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: taskDbId,
    title: 'Draft launch plan',
    properties: {
      [taskEstimatePropId]: 5,
      [taskDuePropId]: '2026-06-24',
      [taskDonePropId]: false,
      [taskProjectPropId]: [projectRow.row.id],
    },
  });
  assert(taskRow?.row?.id, 'task row must be created');

  let freshProject = await rowById(baseUrl, projectDbId, projectRow.row.id);
  assert(
    idArray(freshProject?.properties?.[projectTasksPropId]).includes(taskRow.row.id),
    'creating a relation must back-fill the reciprocal project relation',
  );

  await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: taskRow.row.id,
    patch: {
      properties: {
        [taskProjectPropId]: [],
      },
    },
  });
  freshProject = await rowById(baseUrl, projectDbId, projectRow.row.id);
  assert(
    !idArray(freshProject?.properties?.[projectTasksPropId]).includes(taskRow.row.id),
    'clearing a relation must remove the reciprocal project relation',
  );

  const restored = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: taskRow.row.id,
    patch: {
      properties: {
        [taskEstimatePropId]: 8,
        [taskDuePropId]: '2026-06-24/2026-06-30',
        [taskDonePropId]: true,
        [taskProjectPropId]: [projectRow.row.id],
      },
    },
  });
  assert(restored?.row?.properties?.[taskEstimatePropId] === 8, 'regular properties must update with relation changes');
  freshProject = await rowById(baseUrl, projectDbId, projectRow.row.id);
  assert(
    idArray(freshProject?.properties?.[projectTasksPropId]).includes(taskRow.row.id),
    'restoring a relation must restore the reciprocal project relation',
  );
  const secondTaskRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId: taskDbId,
    title: 'Ship launch plan',
    properties: {
      [taskEstimatePropId]: 12,
      [taskDuePropId]: '2026-06-30',
      [taskDonePropId]: false,
      [taskProjectPropId]: [projectRow.row.id],
    },
  });
  assert(secondTaskRow?.row?.id, 'second task row must be created for advanced rollup checks');
  const computedRows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId: taskDbId,
    includeComputed: true,
  });
  const formulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskFormulaPropId];
  const dateFormulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskDateFormulaPropId];
  const ifsFormulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskIfsFormulaPropId];
  const ifsSecondFormulaProjection = computedRows?.computed?.[secondTaskRow.row.id]?.[taskIfsFormulaPropId];
  const advancedFormulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskAdvancedFormulaPropId];
  const dateEdgeFormulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskDateEdgeFormulaPropId];
  const dynamicDateFormulaProjection = computedRows?.computed?.[taskRow.row.id]?.[taskDynamicDateFormulaPropId];
  const rollupProjection = computedRows?.computed?.[taskRow.row.id]?.[taskProjectNameRollupPropId];
  assert(formulaProjection?.value === 'LARGE launch-plan 16 2-1-2-4', 'formula computed value must be projected by page-query');
  assert(formulaProjection?.formatted === 'LARGE launch-plan 16 2-1-2-4', 'formula formatted value must be projected by page-query');
  assert(dateFormulaProjection?.value === '2026/06/27 3 2026-6-24', 'date formula computed value must be projected by page-query');
  assert(dateFormulaProjection?.formatted === '2026/06/27 3 2026-6-24', 'date formula formatted value must be projected by page-query');
  assert(ifsFormulaProjection?.value === 'Done', 'ifs formula first matching branch must be projected by page-query');
  assert(ifsSecondFormulaProjection?.value === 'Large', 'ifs formula later matching branch must be projected by page-query');
  assert(
    advancedFormulaProjection?.value === '3/8/6/4/3/18/2.24/-1/24-13-45-2/2026-06-24/2026-06-30/1689024900000',
    'advanced Notion-style formula functions must be projected by page-query',
  );
  assert(
    dateEdgeFormulaProjection?.value === '2024-02-29/2025-02-28/2024-02-29/2//0',
    'date formula month-end, leap-day, and invalid-date edge cases must be projected by page-query',
  );
  assertDynamicDateFormula(dynamicDateFormulaProjection?.value);
  assert(rollupProjection?.value === 'Launch project', 'show_original rollup value must be projected by page-query');
  assert(rollupProjection?.formatted === 'Launch project', 'show_original rollup formatted value must be projected by page-query');
  const projectComputedRows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId: projectDbId,
    includeComputed: true,
  });
  const sumProjection = projectComputedRows?.computed?.[projectRow.row.id]?.[projectEstimateSumRollupPropId];
  const medianProjection = projectComputedRows?.computed?.[projectRow.row.id]?.[projectEstimateMedianRollupPropId];
  const rangeProjection = projectComputedRows?.computed?.[projectRow.row.id]?.[projectEstimateRangeRollupPropId];
  const donePercentProjection = projectComputedRows?.computed?.[projectRow.row.id]?.[projectDonePercentRollupPropId];
  const dueRangeProjection = projectComputedRows?.computed?.[projectRow.row.id]?.[projectDueRangeRollupPropId];
  assert(sumProjection?.value === 20, 'numeric rollup sum value must be projected by page-query');
  assert(sumProjection?.formatted === '20', 'numeric rollup sum formatted value must be projected by page-query');
  assert(medianProjection?.value === 10, 'numeric rollup median value must be projected by page-query');
  assert(medianProjection?.formatted === '10', 'numeric rollup median formatted value must be projected by page-query');
  assert(rangeProjection?.value === 4, 'numeric rollup range value must be projected by page-query');
  assert(rangeProjection?.formatted === '4', 'numeric rollup range formatted value must be projected by page-query');
  assert(donePercentProjection?.value === '50%', 'checkbox rollup percent value must be projected by page-query');
  assert(donePercentProjection?.formatted === '50%', 'checkbox rollup percent formatted value must be projected by page-query');
  assert(dueRangeProjection?.value === '2026-06-24 → 2026-06-30', 'date rollup range value must be projected by page-query');
  assert(dueRangeProjection?.formatted === '2026-06-24 → 2026-06-30', 'date rollup range formatted value must be projected by page-query');
  console.log('PASS formula and rollup values are projected by the backend page-query product API.');

  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: taskRow.row.id,
    patch: {
      properties: {
        [taskProjectPropId]: [crypto.randomUUID()],
      },
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: taskRow.row.id,
    patch: {
      properties: {
        [taskFormulaPropId]: 16,
      },
    },
  }, 400);
  console.log('PASS reciprocal relation sync and row update validation work through product APIs.');

  const cleanupPropId = crypto.randomUUID();
  const cleanupRollupPropId = crypto.randomUUID();
  const cleanupViewId = crypto.randomUUID();
  const cleanupTemplateId = crypto.randomUUID();
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: cleanupPropId,
      databaseId: taskDbId,
      name: 'Cleanup legacy',
      type: 'rich_text',
      config: {},
      position: 50,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: cleanupRollupPropId,
      databaseId: projectDbId,
      name: 'Cleanup legacy rollup',
      type: 'rollup',
      config: {
        rollupRelationPropertyId: projectTasksPropId,
        rollupTargetPropertyId: cleanupPropId,
        rollupFunction: 'show_original',
      },
      position: 20,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'update',
    id: taskRow.row.id,
    patch: {
      properties: {
        [cleanupPropId]: 'legacy value',
      },
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: cleanupViewId,
      databaseId: taskDbId,
      name: 'Cleanup table',
      type: 'table',
      config: {
        visibleProperties: [cleanupPropId, taskEstimatePropId],
        propertyOrder: [cleanupPropId, taskEstimatePropId],
        propertyWidths: { [cleanupPropId]: 180 },
        tableCalculations: { [cleanupPropId]: 'count_values' },
        filters: [{ propertyId: cleanupPropId, operator: 'contains', value: 'legacy' }],
        filterGroup: {
          conjunction: 'and',
          filters: [{ propertyId: cleanupPropId, operator: 'contains', value: 'legacy' }],
          groups: [
            {
              conjunction: 'or',
              filters: [{ propertyId: cleanupPropId, operator: 'contains', value: 'value' }],
              groups: [],
            },
          ],
        },
        sorts: [{ propertyId: cleanupPropId, direction: 'ascending' }],
        wrappedColumns: [cleanupPropId],
        coverProperty: cleanupPropId,
      },
      position: 20,
    },
  });
  await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_templates',
    record: {
      id: cleanupTemplateId,
      databaseId: taskDbId,
      name: 'Cleanup template',
      title: 'Cleanup row',
      properties: {
        [cleanupPropId]: 'template legacy value',
      },
      blocks: [],
      isDefault: false,
      position: 20,
    },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'update',
    table: 'db_properties',
    id: cleanupPropId,
    databaseId: projectDbId,
    patch: {
      description: 'wrong database guard',
    },
  }, 400);
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'delete',
    table: 'db_properties',
    id: cleanupPropId,
    databaseId: projectDbId,
  }, 400);
  const deletedCleanupProperty = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'delete',
    table: 'db_properties',
    id: cleanupPropId,
    databaseId: taskDbId,
  });
  assert(deletedCleanupProperty?.cleanup?.rows >= 1, 'property delete cleanup must remove row values');
  assert(deletedCleanupProperty?.cleanup?.views >= 1, 'property delete cleanup must remove view references');
  assert(deletedCleanupProperty?.cleanup?.templates >= 1, 'property delete cleanup must remove template defaults');
  assert(
    deletedCleanupProperty?.cleanup?.properties >= 1,
    'property delete cleanup must remove dependent rollup property references',
  );
  const cleanedRow = await rowById(baseUrl, taskDbId, taskRow.row.id);
  assert(!(cleanupPropId in (cleanedRow?.properties ?? {})), 'deleted property value must be removed from rows');
  const cleanedTaskDatabase = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: taskDbId,
  });
  const cleanupView = cleanedTaskDatabase?.views?.find((view) => view.id === cleanupViewId);
  assert(cleanupView, 'cleanup view must remain after property delete');
  assert(
    !containsExactValue(cleanupView.config, cleanupPropId),
    'deleted property id must be removed from view config',
  );
  const cleanupTemplate = cleanedTaskDatabase?.templates?.find((template) => template.id === cleanupTemplateId);
  assert(cleanupTemplate, 'cleanup template must remain after property delete');
  assert(
    !(cleanupPropId in (cleanupTemplate.properties ?? {})),
    'deleted property id must be removed from template defaults',
  );
  const cleanedProjectDatabase = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'database',
    databaseId: projectDbId,
  });
  const cleanupRollup = cleanedProjectDatabase?.properties?.find((prop) => prop.id === cleanupRollupPropId);
  assert(cleanupRollup, 'dependent rollup property must remain after source property delete');
  assert(
    !containsExactValue(cleanupRollup.config, cleanupPropId),
    'deleted property id must be removed from dependent rollup config',
  );
  console.log('PASS database property deletion cleans row, view, template, and dependent rollup references.');

  console.log('\nPASS database relation, rollup, and formula validation works through product APIs.');
}

async function createDatabase(baseUrl, title, position, properties) {
  const id = crypto.randomUUID();
  const created = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'createDatabase',
    id,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    title,
    position,
    seedRows: false,
    properties,
  });
  assert(created?.page?.id === id, `database ${title} must be created`);
  assert(created?.views?.length === 1, `database ${title} must include a default view`);
  if (properties) {
    const propertyNames = new Set((created.properties ?? []).map((prop) => prop.name));
    assert(propertyNames.has('Task'), `database ${title} must include the custom title property`);
    assert(propertyNames.has('Estimate'), `database ${title} must include the custom number property`);
    assert(propertyNames.has('Stage'), `database ${title} must include the custom status property`);
    assert(propertyNames.has('Estimate label'), `database ${title} must include the custom formula property`);
    console.log('PASS custom database creation schemas are accepted and validated by product APIs.');
  }
  return id;
}

async function rowById(baseUrl, databaseId, rowId) {
  const rows = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  });
  return rows?.rows?.find((row) => row.id === rowId);
}

function idArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === '') return [];
  return [String(value)].filter(Boolean);
}

function containsExactValue(value, target) {
  if (value === target) return true;
  if (Array.isArray(value)) return value.some((item) => containsExactValue(item, target));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsExactValue(item, target));
  }
  return false;
}

async function cleanup() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);
  for (const id of [customDbId, taskDbId, projectDbId, otherDbId]) {
    if (!id) continue;
    await callFunction(baseUrl, owner.token, 'page-mutation', {
      action: 'delete',
      id,
    }).catch(() => {});
  }
  taskDbId = '';
  projectDbId = '';
  otherDbId = '';
  customDbId = '';
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
  console.log(`Usage: node scripts/database-relation-smoke.mjs [options]

Checks relation target validation, rollup/formula schema validation, reciprocal
relation sync, and read-only row property protection against a running
Notionlike EdgeBase runtime.

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

function assertDynamicDateFormula(value) {
  assert(typeof value === 'string', 'now/today formula value must be projected by page-query');
  const parts = value.split('/');
  assert(parts.length === 4, `now/today formula must produce four parts, got ${value}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(parts[0]), `today() must format as YYYY-MM-DD, got ${value}`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(parts[1]), `now() must format as YYYY-MM-DD, got ${value}`);
  assert(parts[2] === 'true', `now() timestamp must be at or after today() timestamp, got ${value}`);
  assert(parts[3] === 'true', `dateBetween(now(), today(), "hours") must be non-negative, got ${value}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
