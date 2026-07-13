#!/usr/bin/env node
// Admin-provisioned account lifecycle smoke:
//   1. master (instance admin) creates a user through instance-admin and
//      receives a one-time temporary password with mustChangePassword set;
//   2. the new user signs in through the AuthGate UI and is blocked by the
//      forced password-change screen until they set their own password;
//   3. server-level membership: the master adds the provisioned account to a
//      workspace directly by email (resolved to the existing account) with no
//      invitation email and no accept step; an unknown email is a blind no-op.
//
// Requires the local dev runtime (npm --prefix backend run dev) with the dev
// master account env (backend package.json dev script provides it).
import {
  assert,
  assertRuntimeReachable,
  deleteSmokeUser,
  deleteSmokeWorkspace,
  loadPlaywright,
  newCheckedPage,
  normalizeBaseUrl,
  resolveChromeExecutable,
  resolveUrl,
  setDefaultTimeoutMs,
  masterCredentials,
} from './lib/harness.mjs';

const BASE = normalizeBaseUrl(process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787');
const { email: MASTER_EMAIL, password: MASTER_PASSWORD } = masterCredentials();
const TIMEOUT_MS = Number(process.env.HANJI_SMOKE_TIMEOUT_MS ?? 30_000);
setDefaultTimeoutMs(TIMEOUT_MS);

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
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function signin(email, password) {
  const { status, json } = await api('/api/auth/signin', { email, password });
  assert(status === 200, `signin ${email} expected 200, got ${status}: ${JSON.stringify(json).slice(0, 200)}`);
  const token = json.accessToken ?? json.session?.accessToken;
  assert(token, `signin ${email} returned no access token`);
  return token;
}

async function main() {
  await assertRuntimeReachable(BASE);
  const suffix = Date.now();
  const userEmail = `provisioned-${suffix}@example.com`;
  let masterToken = '';
  let createdUserId = '';
  let userCleanupToken = '';
  let createdWorkspace = null;
  let runError = null;

  try {
    // 1. Master provisions the account.
    masterToken = await signin(MASTER_EMAIL, MASTER_PASSWORD);
    const created = await api(
      '/api/functions/instance-admin',
      {
        action: 'createUser',
        email: userEmail,
        displayName: `Provisioned ${suffix}`,
        query: userEmail,
      },
      masterToken,
    );
    assert(created.status === 200, `createUser expected 200, got ${created.status}: ${JSON.stringify(created.json).slice(0, 200)}`);
    createdUserId = (created.json.users ?? []).find(
      (user) => String(user.email ?? '').toLowerCase() === userEmail,
    )?.id ?? '';
    assert(createdUserId, 'createUser response should include the synthetic account id for cleanup');
    const tempPassword = created.json.temporaryPassword;
    assert(typeof tempPassword === 'string' && tempPassword.length >= 10, 'createUser should return a temporary password');
    console.log('PASS instance-admin createUser returns a one-time temporary password.');

    userCleanupToken = await signin(userEmail, tempPassword);
    const flags = await api('/api/functions/account-state', { action: 'get' }, userCleanupToken);
    assert(flags.json.mustChangePassword === true, 'admin-created account should carry mustChangePassword');
    console.log('PASS account-state reports mustChangePassword for the provisioned account.');

    // 2. Forced password change through the UI.
    const { chromium } = await loadPlaywright({ label: 'admin-provisioning smoke' });
    const browser = await chromium.launch({ executablePath: resolveChromeExecutable() });
    const newPassword = `Provisioned!${suffix}aA`;
    try {
      const { context, page } = await newCheckedPage(browser);
      await page.goto(resolveUrl(BASE, '/'), { waitUntil: 'domcontentloaded' });
      const passwordField = page.getByLabel('Password', { exact: true }).first();
      await passwordField.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      await page.getByRole('textbox', { name: 'Email' }).fill(userEmail);
      await passwordField.fill(tempPassword);
      await page.getByRole('button', { name: 'Continue', exact: true }).click({ timeout: TIMEOUT_MS });

      const mustChange = page.locator('[data-testid="must-change-password"]');
      await mustChange.waitFor({ state: 'visible', timeout: TIMEOUT_MS });
      console.log('PASS temporary-password sign-in lands on the forced password-change screen.');

      await page.locator('#must-change-current').fill(tempPassword);
      await page.locator('#must-change-next').fill(newPassword);
      await page.locator('#must-change-confirm').fill(newPassword);
      await mustChange.getByRole('button').last().click({ timeout: TIMEOUT_MS });
      await page.locator('button[aria-label="Open workspace menu"]').waitFor({
        state: 'visible',
        timeout: TIMEOUT_MS,
      });
      console.log('PASS forced password change unlocks the workspace shell.');

      userCleanupToken = await signin(userEmail, newPassword);
      const cleared = await api('/api/functions/account-state', { action: 'get' }, userCleanupToken);
      assert(cleared.json.mustChangePassword === false, 'flag should clear after the password change');
      console.log('PASS mustChangePassword clears after the change.');

      // 3. Server-level membership: the master adds the provisioned account to a
      //    workspace directly (no invitation email and no accept step). An email that
      //    matches an existing account is resolved and added immediately.
      const workspace = await api(
        '/api/functions/workspace-mutation',
        { action: 'createWorkspace', name: `Member target ${suffix}` },
        masterToken,
      );
      const workspaceId = workspace.json.workspace?.id;
      assert(workspaceId, `createWorkspace failed: ${JSON.stringify(workspace.json).slice(0, 200)}`);
      createdWorkspace = workspace.json.workspace;

      const added = await api(
        '/api/functions/workspace-mutation',
        { action: 'addMember', workspaceId, email: userEmail, role: 'member' },
        masterToken,
      );
      assert(added.status === 200, `addMember expected 200, got ${added.status}: ${JSON.stringify(added.json).slice(0, 200)}`);
      assert(
        (added.json.members ?? []).some((member) => (member.email ?? '').toLowerCase() === userEmail),
        `addMember should resolve the account email into membership: ${JSON.stringify(added.json).slice(0, 200)}`,
      );
      console.log('PASS addMember resolves an existing account email into workspace membership.');

      // A blind add for an unknown email returns 200 but creates nothing, so the
      // caller cannot tell a real account apart from a typo.
      const ghostEmail = `ghost-${suffix}@example.com`;
      const ghost = await api(
        '/api/functions/workspace-mutation',
        { action: 'addMember', workspaceId, email: ghostEmail, role: 'member' },
        masterToken,
      );
      assert(ghost.status === 200, `blind addMember expected 200, got ${ghost.status}: ${JSON.stringify(ghost.json).slice(0, 200)}`);
      assert(
        !(ghost.json.members ?? []).some((member) => (member.email ?? '').toLowerCase() === ghostEmail),
        'blind add for an unknown email must not create a member',
      );
      console.log('PASS addMember is a blind no-op for an unknown email.');

      const members = await api(
        '/api/functions/workspace-mutation',
        { action: 'members', workspaceId },
        masterToken,
      );
      assert(
        (members.json.members ?? []).some((member) => (member.email ?? '').toLowerCase() === userEmail),
        'added account should be a workspace member',
      );
      console.log('PASS existing server account is added as a workspace member without an invitation flow.');
      await context.close();
    } finally {
      await browser.close().catch(() => {});
    }

    console.log('PASS admin provisioning + forced password change + server-account membership works end to end.');
  } catch (error) {
    runError = error;
  } finally {
    const cleanupErrors = [];
    if (userCleanupToken && createdUserId) {
      try {
        const list = await api(
          '/api/functions/workspace-mutation',
          { action: 'list' },
          userCleanupToken,
        );
        for (const workspace of list.json.workspaces ?? []) {
          if (workspace?.ownerId !== createdUserId) continue;
          await deleteSmokeWorkspace(BASE, userCleanupToken, workspace, { timeoutMs: TIMEOUT_MS });
        }
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (masterToken && createdWorkspace) {
      try {
        await deleteSmokeWorkspace(BASE, masterToken, createdWorkspace, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (masterToken && createdUserId) {
      try {
        await deleteSmokeUser(BASE, masterToken, createdUserId, { timeoutMs: TIMEOUT_MS });
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (cleanupErrors.length > 0) {
      const cleanupError = new Error(`admin-provisioning smoke cleanup failed: ${cleanupErrors.join('; ')}`);
      if (!runError) runError = cleanupError;
      else console.error(`WARN ${cleanupError.message}`);
    }
  }
  if (runError) throw runError;
}

try {
  await main();
} catch (error) {
  console.error(`\nFAIL admin provisioning smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
