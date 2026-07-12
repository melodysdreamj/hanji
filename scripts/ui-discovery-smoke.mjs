#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const DEFAULT_CHILD_TIMEOUT_MS = '45000';
const DEFAULT_CHILD_RETRIES = 1;
const childArgs = hasTimeoutArg(args) ? args : [...args, '--timeout-ms', DEFAULT_CHILD_TIMEOUT_MS];
const childRetries = parseChildRetries();

try {
  if (!hasTimeoutArg(args)) {
    console.log(`[ui-discovery] using --timeout-ms ${DEFAULT_CHILD_TIMEOUT_MS} for each child smoke`);
  }
  if (childRetries > 0) {
    console.log(`[ui-discovery] retrying failed child smokes up to ${childRetries} time${childRetries === 1 ? '' : 's'}`);
  }
  await run('signup first workspace visual discovery', 'first-workspace-visual-smoke.mjs', childArgs);
  await run('populated page visual discovery', 'populated-page-visual-smoke.mjs', childArgs);
  await run('dialog visual discovery', 'dialog-visual-smoke.mjs', childArgs);
  await run('share dialog visual discovery', 'share-dialog-visual-smoke.mjs', childArgs);
  await run('search dialog result visual discovery', 'search-dialog-visual-smoke.mjs', childArgs);
  await run('comments panel visual discovery', 'comments-panel-visual-smoke.mjs', childArgs);
  await run('updates panel visual discovery', 'updates-panel-visual-smoke.mjs', childArgs);
  await run('templates dialog visual discovery', 'templates-dialog-visual-smoke.mjs', childArgs);
  await run('import dialog visual discovery', 'import-dialog-visual-smoke.mjs', childArgs);
  await run('trash visual discovery', 'trash-visual-smoke.mjs', childArgs);
  await run('public share visual discovery', 'public-share-visual-smoke.mjs', childArgs);
  await run('workspace settings visual discovery', 'workspace-settings-visual-smoke.mjs', childArgs);
  await run('workspace switcher visual discovery', 'workspace-switcher-visual-smoke.mjs', childArgs);
  await run('slash menu visual discovery', 'slash-menu-visual-smoke.mjs', childArgs);
  await run('block actions visual discovery', 'block-actions-visual-smoke.mjs', childArgs);
  await run('block drag visual discovery', 'block-drag-ui-smoke.mjs', childArgs);
  await run('nested blocks visual discovery', 'nested-blocks-visual-smoke.mjs', childArgs);
  await run('backlinks visual discovery', 'backlinks-visual-smoke.mjs', childArgs);
  await run('mentions visual discovery', 'mentions-visual-smoke.mjs', childArgs);
  await run('page chrome layout discovery', 'page-chrome-ui-smoke.mjs', childArgs);
  await run('page tree/sidebar layout discovery', 'page-tree-ui-smoke.mjs', childArgs);
  await run('first database visual discovery', 'database-view-ui-smoke.mjs', childArgs);
  await run('database view tabs visual discovery', 'database-view-tabs-visual-smoke.mjs', childArgs);
  await run('database toolbar visual discovery', 'database-toolbar-visual-smoke.mjs', childArgs);
  await run('database property visual discovery', 'database-property-visual-smoke.mjs', childArgs);
  await run('inline database visual discovery', 'inline-database-visual-smoke.mjs', childArgs);
  await run('database row peek visual discovery', 'database-row-peek-visual-smoke.mjs', childArgs);
  console.log('\nPASS UI discovery smoke completed.');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL UI discovery smoke: ${message}`);
  process.exitCode = 1;
}

function hasTimeoutArg(scriptArgs) {
  return scriptArgs.some((arg) => arg === '--timeout-ms' || arg === '--timeout');
}

function parseChildRetries() {
  const raw = process.env.UI_DISCOVERY_CHILD_RETRIES;
  if (raw === undefined || raw === '') return DEFAULT_CHILD_RETRIES;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error('UI_DISCOVERY_CHILD_RETRIES must be a non-negative integer');
  }
  return value;
}

async function run(label, script, scriptArgs) {
  let attempt = 0;
  while (true) {
    try {
      await runOnce(label, script, scriptArgs, attempt);
      return;
    } catch (error) {
      if (attempt >= childRetries) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ui-discovery] ${label} failed on attempt ${attempt + 1}; retrying. ${message}`);
      attempt += 1;
    }
  }
}

function runOnce(label, script, scriptArgs, attempt) {
  return new Promise((resolveRun, rejectRun) => {
    console.log(`\n[ui-discovery] ${label}${attempt > 0 ? ` (retry ${attempt})` : ''}`);
    const child = spawn(process.execPath, [join(root, 'scripts', script), ...scriptArgs], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`));
    });
  });
}
