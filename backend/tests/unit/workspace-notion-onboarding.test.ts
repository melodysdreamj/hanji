import { describe, expect, it } from 'vitest';
import { POST } from '../../functions/workspace-mutation';
import { fakeDb, type Row } from './helpers/fake-db';
import { callFunction } from './helpers/function-context';

const OWNER = 'owner-1';

function onboardingDb(overrides: Record<string, Row[]> = {}) {
  return fakeDb({
    workspaces: [{ id: 'ws1', name: 'Fresh workspace', ownerId: OWNER }],
    workspace_members: [],
    workspace_invitations: [],
    instance_settings: [{ id: 'global', masterUserId: OWNER, instanceAdminUserIds: [] }],
    workspace_onboarding: [],
    pages: [{
      id: 'welcome',
      workspaceId: 'ws1',
      parentId: null,
      parentType: 'workspace',
      kind: 'page',
      title: 'Welcome to Hanji!',
      icon: '👋',
      iconType: 'emoji',
      inTrash: false,
    }],
    notion_import_jobs: [],
    notion_import_connections: [],
    ...overrides,
  });
}

async function claim(database = onboardingDb(), actorId = OWNER) {
  return (await callFunction(POST, database, actorId, {
    action: 'claimNotionImportOnboarding',
    workspaceId: 'ws1',
  })) as { show?: boolean };
}

describe('workspace Notion import onboarding', () => {
  it('atomically shows once for the instance administrator on a starter-only workspace', async () => {
    const database = onboardingDb();
    const [first, second] = await Promise.all([claim(database), claim(database)]);

    expect([first.show, second.show].sort()).toEqual([false, true]);
    expect(database.tables.workspace_onboarding).toHaveLength(1);
    expect(database.tables.workspace_onboarding[0]).toMatchObject({
      id: 'ws1',
      workspaceId: 'ws1',
      notionImportState: 'presented',
      notionImportPresentedBy: OWNER,
    });
    expect((await claim(database)).show).toBe(false);
  });

  it('does not show to a workspace owner who is not an instance administrator', async () => {
    const database = onboardingDb({
      instance_settings: [{ id: 'global', masterUserId: 'different-admin', instanceAdminUserIds: [] }],
    });

    expect((await claim(database)).show).toBe(false);
    expect(database.tables.workspace_onboarding).toHaveLength(0);
  });

  it('does not show after meaningful content or Notion import state exists', async () => {
    const populated = onboardingDb({
      pages: [
        ...onboardingDb().tables.pages,
        { id: 'real-page', workspaceId: 'ws1', parentType: 'workspace', kind: 'page', title: 'Plan' },
      ],
    });
    const imported = onboardingDb({
      notion_import_jobs: [{ id: 'job-1', workspaceId: 'ws1', status: 'completed' }],
    });
    const connected = onboardingDb({
      notion_import_connections: [{ id: 'connection-1', workspaceId: 'ws1', status: 'active' }],
    });

    expect((await claim(populated)).show).toBe(false);
    expect((await claim(imported)).show).toBe(false);
    expect((await claim(connected)).show).toBe(false);
  });

  it('suppresses the prompt when workspace creation already asked how to start', async () => {
    const database = onboardingDb();
    const result = (await callFunction(POST, database, OWNER, {
      action: 'suppressNotionImportOnboarding',
      workspaceId: 'ws1',
    })) as { suppressed?: boolean };

    expect(result.suppressed).toBe(true);
    expect(database.tables.workspace_onboarding[0]).toMatchObject({
      notionImportState: 'suppressed',
      notionImportSuppressedBy: OWNER,
    });
    expect((await claim(database)).show).toBe(false);
  });
});
