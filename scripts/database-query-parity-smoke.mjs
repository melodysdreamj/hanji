#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const requireFromWeb = createRequire(new URL('../web/package.json', import.meta.url));
const esbuild = requireFromWeb('esbuild');

async function loadFormulaCore() {
  const dir = await mkdtemp(join(tmpdir(), 'notionlike-formula-core-'));
  const outfile = join(dir, 'formula-core.mjs');
  await esbuild.build({
    entryPoints: [join(rootDir, 'shared/database/formula-core.ts')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return {
    mod,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const props = [
  { id: 'name', name: 'Name', type: 'title' },
  { id: 'estimate', name: 'Estimate', type: 'number' },
  { id: 'done', name: 'Done', type: 'checkbox' },
  {
    id: 'status',
    name: 'Status',
    type: 'status',
    config: {
      options: [
        { id: 'small', name: 'Small' },
        { id: 'large', name: 'Large' },
      ],
    },
  },
  {
    id: 'tags',
    name: 'Tags',
    type: 'multi_select',
    config: {
      options: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
      ],
    },
  },
  { id: 'due', name: 'Due', type: 'date' },
  { id: 'code', name: 'Code', type: 'rich_text' },
  { id: 'formula', name: 'Summary', type: 'formula', config: { formula: '' } },
];

const row = {
  id: 'row-1',
  title: 'Launch Plan',
  properties: {
    estimate: 8,
    done: true,
    status: 'large',
    tags: ['alpha', 'beta'],
    due: { start: '2026-06-24', end: '2026-06-27' },
    code: 'launch-plan',
  },
};

function optionName(prop, value) {
  const options = Array.isArray(prop.config?.options) ? prop.config.options : [];
  const match = options.find((option) => option?.id === value || option?.name === value);
  return typeof match?.name === 'string' ? match.name : String(value ?? '');
}

function frontRawValue(page, prop) {
  if (prop.type === 'title') return page.title;
  if (prop.type === 'created_time') return page.createdAt;
  if (prop.type === 'last_edited_time') return page.updatedAt;
  if (prop.type === 'created_by') return page.createdBy;
  if (prop.type === 'last_edited_by') return page.lastEditedBy;
  return page.properties?.[prop.id];
}

function frontDisplayPropertyValue(page, prop) {
  const value = frontRawValue(page, prop);
  if (prop.type === 'title') return page.title || 'Untitled';
  if (prop.type === 'select' || prop.type === 'status') return value ? optionName(prop, String(value)) : '';
  if (prop.type === 'multi_select') {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values.map((item) => optionName(prop, String(item))).filter(Boolean).join(', ');
  }
  if (prop.type === 'checkbox') return value ? 'Checked' : 'Unchecked';
  if (value == null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function frontendResolver(currentProp) {
  return (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === currentProp.id) return '';
    const value = frontRawValue(row, target);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (value == null) return '';
    if (target.type === 'number' || target.type === 'checkbox') return value;
    if (target.type === 'date') {
      if (typeof value === 'string') return value;
      if (value && typeof value === 'object') {
        const start = value.start;
        const end = value.end;
        if (typeof start === 'string' && typeof end === 'string' && end) return `${start}/${end}`;
        return typeof start === 'string' ? start : '';
      }
    }
    return frontDisplayPropertyValue(row, target);
  };
}

function backendPropertyValue(page, prop) {
  if (prop.type === 'title') return page.title ?? '';
  const value = page.properties?.[prop.id];
  if (value == null) return '';
  if (prop.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (prop.type === 'checkbox') return value === true;
  if (prop.type === 'select' || prop.type === 'status') return optionName(prop, value);
  if (prop.type === 'multi_select') {
    const items = Array.isArray(value) ? value : [value];
    return items.map((item) => optionName(prop, item)).filter(Boolean).join(', ');
  }
  if (prop.type === 'date') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const start = value.start;
      const end = value.end;
      if (typeof start === 'string' && typeof end === 'string' && end) return `${start}/${end}`;
      return typeof start === 'string' ? start : '';
    }
  }
  if (prop.type === 'formula' || prop.type === 'rollup') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}

function backendResolver(currentProp) {
  return (name) => {
    const target = props.find((item) => item.name === name || item.id === name);
    if (!target || target.id === currentProp.id) return '';
    return backendPropertyValue(row, target);
  };
}

const cases = [
  {
    label: 'numeric operators',
    expression: 'prop("Estimate") * 2',
    expected: 16,
  },
  {
    label: 'select and multi-select display values',
    expression: 'concat(prop("Name"), ":", prop("Status"), ":", prop("Tags"))',
    expected: 'Launch Plan:Large:Alpha, Beta',
  },
  {
    label: 'ifs first matching branch',
    expression: 'ifs(prop("Done"), "Done", prop("Estimate") > 10, "Large", true, "Small")',
    expected: 'Done',
  },
  {
    label: 'date range helpers',
    expression: 'formatDate(prop("Due"), "YYYY/MM/DD") + " " + dateBetween(dateEnd(prop("Due")), dateStart(prop("Due")), "days")',
    expected: '2026/06/24 3',
  },
  {
    label: 'timezone offset parse and format',
    expression: 'formatDate(parseDate("2024-03-10T01:30:00-08:00"), "YYYY-MM-DD HH:mm")',
    expected: '2024-03-10 09:30',
  },
  {
    label: 'DST spring-forward absolute hour difference',
    expression: 'dateBetween(parseDate("2024-03-10T03:30:00-07:00"), parseDate("2024-03-10T01:30:00-08:00"), "hours")',
    expected: 1,
  },
  {
    label: 'date range start and end endpoints',
    expression: 'dateStart(dateRange("2024-11-03T01:30:00-07:00", "2024-11-03T01:30:00-08:00")) + "/" + dateEnd(dateRange("2024-11-03T01:30:00-07:00", "2024-11-03T01:30:00-08:00"))',
    expected: '2024-11-03/2024-11-03',
  },
  {
    label: 'invalid dates and empty coercion',
    expression: 'concat(parseDate("2024-02-31"), ":", timestamp(parseDate("2024-02-31")), ":", empty(null), ":", empty(""), ":", empty(0), ":", toNumber(""))',
    expected: ':0:true:true:true:0',
  },
  {
    label: 'month-end and leap-day dateAdd',
    expression: 'dateAdd("2024-01-31", 1, "months") + " " + dateAdd("2024-02-29", 1, "years")',
    expected: '2024-02-29 2025-02-28',
  },
  {
    label: 'lets, repeat, and rounding',
    expression: 'lets(x, prop("Estimate"), y, 2, repeat(prop("Code"), y) + " " + round(x / 3, 2))',
    expected: 'launch-planlaunch-plan 2.67',
  },
  {
    label: 'fixed today and now',
    expression: 'concat(today(), " ", now())',
    expected: '2026-07-03 2026-07-03T09:10:11Z',
  },
  {
    label: 'unsupported function remains blank',
    expression: 'map(prop("Name"))',
    expected: '',
  },
];

const { mod, cleanup } = await loadFormulaCore();
try {
  const formulaProp = props.find((prop) => prop.id === 'formula');
  const now = () => new Date('2026-07-03T09:10:11Z');

  for (const testCase of cases) {
    const front = mod.evaluateFormulaExpression(testCase.expression, frontendResolver(formulaProp), { now });
    const back = mod.evaluateFormulaExpression(testCase.expression, backendResolver(formulaProp), { now });
    assert.deepEqual(front, back, `${testCase.label}: frontend/backend resolver results diverged`);
    assert.deepEqual(front, testCase.expected, `${testCase.label}: shared formula core result changed`);
    assert.equal(
      mod.formatFormulaValue(front),
      mod.formatFormulaValue(back),
      `${testCase.label}: formatted frontend/backend results diverged`,
    );
  }

  const variables = mod.formulaVariableNames(mod.tokenizeFormula('lets(x, 1, y, 2, concat(x, y))'));
  assert(variables.has('x') && variables.has('y'), 'formula warning variable extraction must include lets bindings');

  console.log('PASS database formula frontend/backend parity smoke');
} finally {
  await cleanup();
}
