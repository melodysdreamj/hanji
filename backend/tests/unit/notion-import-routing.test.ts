import { describe, it } from 'vitest';

import { POST } from '../../functions/notion-import';
import { fakeDb } from './helpers/fake-db';
import { callFunction, expectErrorResponse } from './helpers/function-context';

describe('notion-import handler routing and status mapping', () => {
  it('maps a missing workspace routing hint instead of leaking a rejected handler promise', async () => {
    const result = await callFunction(POST, fakeDb(), 'user-1', { action: 'list' });
    await expectErrorResponse(
      result,
      400,
      'workspaceId is required. This action needs a workspaceId for workspace routing.',
    );
  });

  it('keeps unknown actions as client errors once a workspace route is present', async () => {
    const result = await callFunction(POST, fakeDb(), 'user-1', {
      action: 'not-a-real-action',
      workspaceId: 'ws1',
    });
    await expectErrorResponse(result, 400, 'Unknown Notion import action.');
  });
});
