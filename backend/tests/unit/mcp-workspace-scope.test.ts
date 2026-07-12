import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Regression guard for the hosted-MCP selected-workspace scoping bypass (#2):
// requireWorkspaceArgument only validates the caller-supplied workspace_id, not
// the resource id the tool then operates on. Every workspace-bound tool that
// dispatches to callNotionCompat with a caller-controlled page/database/data
// source/view id MUST first scope-check that id against the grant's selected
// workspace (requirePageInWorkspace, requireBlockInWorkspace, or
// assertResourceInSelectedWorkspace),
// exactly as duplicatePage/movePages/queryDatabaseView already did.

const backendDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = readFileSync(resolve(backendDir, 'functions/mcp.ts'), 'utf8');

function functionBody(name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`Could not find function ${name} in mcp.ts`);
  // End at the next top-level function declaration.
  const rest = source.slice(start + `async function ${name}(`.length);
  const nextFn = rest.search(/\nasync function |\nfunction /);
  return nextFn < 0 ? rest : rest.slice(0, nextFn);
}

function hasScopeGuard(body: string): boolean {
  return (
    body.includes('requirePageInWorkspace(context, grant, selected.workspaceId,') ||
    body.includes('requireDatabaseInWorkspace(') ||
    body.includes('requireBlockInWorkspace(context, grant, selected.workspaceId,') ||
    body.includes('resolveDestinationParent(') ||
    body.includes('assertResourceInSelectedWorkspace(context, grant, selected.workspaceId,')
  );
}

describe('MCP hosted tools scope resource ids to the selected workspace (#2)', () => {
  it('defines the lenient assertResourceInSelectedWorkspace guard', () => {
    expect(source).toContain('async function assertResourceInSelectedWorkspace(');
    // It must reject cross-workspace resolvable ids.
    const body = functionBody('assertResourceInSelectedWorkspace');
    expect(body).toContain('page.workspaceId !== workspaceId');
  });

  it('resolves block ids only inside the selected workspace', () => {
    const body = functionBody('requireBlockInWorkspace');
    expect(body).toContain('boundedDb(context.admin, workspaceId)');
    expect(body).toContain("table<BlockRecord>('blocks')");
    expect(body).toContain('requirePageInWorkspace(context, grant, workspaceId, block.pageId');
  });

  for (const tool of [
    'fetchNotion',
    'searchNotion',
    'queryDataSources',
    'createPages',
    'updatePage',
    'updateDataSource',
    'createView',
    'updateView',
    'commentsTool',
    'createDatabase',
  ]) {
    it(`${tool} scope-checks its resource id`, () => {
      expect(hasScopeGuard(functionBody(tool))).toBe(true);
    });
  }

  it('keeps the pre-existing guards on the sibling tools', () => {
    expect(hasScopeGuard(functionBody('queryDatabaseView'))).toBe(true);
    expect(hasScopeGuard(functionBody('duplicatePage'))).toBe(true);
  });

  it('never distinguishes cross-workspace pages from missing ones (existence oracle)', () => {
    // A grant holder probing arbitrary live page UUIDs must get the identical
    // not-found-shaped error whether the page is missing or in another
    // workspace, so the message that leaked existence must stay gone.
    expect(source).not.toContain('outside the selected workspace');
  });

  it('list_workspaces requires the workspace:read scope like its alias', () => {
    const body = functionBody('callTool');
    const branch = body.slice(body.indexOf("toolName === 'list_workspaces'"));
    expect(branch.indexOf("requireGrantScope(grant, ['workspace:read'])")).toBeGreaterThan(-1);
    expect(branch.indexOf("requireGrantScope(grant, ['workspace:read'])"))
      .toBeLessThan(branch.indexOf('grantedAccessibleWorkspaces'));
  });
});
