#!/usr/bin/env node

import {
  deleteSmokeAccounts,
  masterCredentials,
  permanentlyDeleteDatabaseRow,
  permanentlyDeletePage,
} from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let viewer;
let viewOnly;
let workspaceMember;
let fullAccessUser;
let groupAccessUser;
let emailShareUser;
let workspaceId = '';
let viewerWorkspaceId = '';
let workspaceMemberId = '';
let groupAccessWorkspaceMemberId = '';
let organizationId = '';
let organizationGroupId = '';
let organizationGroupMemberId = '';
let pageId = '';
let childPageId = '';
let databaseId = '';
let dbPropertyId = '';
let dbViewId = '';
let dbTemplateId = '';
let viewerSchemaPropertyId = '';
let viewerSchemaViewId = '';
let viewerSchemaTemplateId = '';
let ownerRowId = '';
let viewerRowId = '';
let viewPermissionId = '';
let permissionId = '';
let fullAccessPermissionId = '';
let emailPermissionId = '';
let groupPermissionId = '';
let delegatedGroupPermissionId = '';
let delegatedPermissionId = '';
let commentId = '';
let emailCommentId = '';
let emailChildCommentId = '';
let childCommentId = '';
let privateBlockId = '';
let childBlockId = '';
let groupAccessBlockId = '';
let ownerRowBlockId = '';

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL multi-user permission smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error(`Start the local EdgeBase runtime first: npm --prefix backend run dev`);
  }
  process.exitCode = 1;
} finally {
  await cleanup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL cleanup failed: ${message}`);
    process.exitCode ||= 1;
  });
}

async function main() {
  const baseUrl = normalizeBaseUrl(options.url);
  console.log(`Multi-user permission smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  owner = await signIn(baseUrl);
  viewer = await signIn(baseUrl);
  viewOnly = await signIn(baseUrl);
  workspaceMember = await signIn(baseUrl);
  fullAccessUser = await signIn(baseUrl);
  groupAccessUser = await signIn(baseUrl);
  assert(owner.userId !== viewer.userId, 'owner and viewer must be different users');
  assert(
    ![owner.userId, viewer.userId].includes(viewOnly.userId),
    'view-only smoke user must be a third user',
  );
  assert(
    ![owner.userId, viewer.userId, viewOnly.userId].includes(workspaceMember.userId),
    'workspace member smoke user must be a fourth user',
  );
  assert(
    ![owner.userId, viewer.userId, viewOnly.userId, workspaceMember.userId].includes(fullAccessUser.userId),
    'full access smoke user must be a fifth user',
  );
  assert(
    ![owner.userId, viewer.userId, viewOnly.userId, workspaceMember.userId, fullAccessUser.userId]
      .includes(groupAccessUser.userId),
    'group access smoke user must be a sixth user',
  );

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  organizationId = bootstrap?.organization?.id ?? '';
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(organizationId, 'workspace-bootstrap must return an organization id');

  const workspaceSlug = `permission-smoke-${crypto.randomUUID().slice(0, 8)}`;
  const updatedWorkspace = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'update',
    id: workspaceId,
    patch: { domain: workspaceSlug.toUpperCase() },
  });
  assert(
    updatedWorkspace?.workspace?.domain === workspaceSlug,
    'workspace URL updates must normalize to a stable slug',
  );
  const slugBootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {
    workspaceSlug,
  });
  assert(
    slugBootstrap?.workspace?.id === workspaceId,
    'workspace-bootstrap workspaceSlug must select the matching accessible workspace',
  );
  await expectFunctionStatus(baseUrl, viewer.token, 'workspace-bootstrap', {
    workspaceSlug,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'workspace-bootstrap', {
    workspaceSlug: `${workspaceSlug}-missing`,
  }, 404);
  const viewerBootstrap = await callFunction(baseUrl, viewer.token, 'workspace-bootstrap', {});
  viewerWorkspaceId = viewerBootstrap?.workspace?.id;
  assert(viewerWorkspaceId, 'viewer workspace-bootstrap must return a workspace id');
  await expectFunctionStatus(baseUrl, viewer.token, 'workspace-mutation', {
    action: 'update',
    id: viewerWorkspaceId,
    patch: { domain: workspaceSlug },
  }, 409);
  console.log('PASS workspace URL slug selection, unavailable feedback, and collision denial.');

  pageId = crypto.randomUUID();
  const privatePageTitle = `Permission smoke private search ${pageId}`;
  const privateBlockText = `Permission smoke hidden block ${pageId}`;
  const ownerRowTitle = `Permission smoke owner row ${pageId}`;
  const ownerRowBlockText = `Permission smoke owner row body ${pageId}`;
  const created = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: pageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: privatePageTitle,
    position: Date.now(),
  });
  assert(created?.page?.id === pageId, 'owner must be able to create a smoke page');
  console.log('PASS owner can create a private page through product API.');

  privateBlockId = crypto.randomUUID();
  const privateBlock = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: privateBlockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: privateBlockText }] },
    plainText: privateBlockText,
    position: 1,
  });
  assert(privateBlock?.block?.id === privateBlockId, 'owner must be able to create a private smoke block');

  await expectFunctionStatus(baseUrl, viewer.token, 'workspace-bootstrap', {
    pageId,
  }, 403);
  console.log('PASS direct page URLs return access denial before sharing.');

  // A non-member must not duplicate a page by id: duplication reads and copies
  // the whole subtree, so an unguarded handler is an arbitrary-page read plus a
  // cross-workspace write primitive. Regression guard for duplicate-page.
  await expectFunctionStatus(baseUrl, viewer.token, 'duplicate-page', {
    action: 'duplicate',
    pageId,
  }, 403);
  console.log('PASS non-member cannot duplicate a private page by id.');

  const memberInvite = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId,
    userId: workspaceMember.userId,
    role: 'member',
  });
  workspaceMemberId = memberInvite?.member?.id;
  assert(workspaceMemberId, 'workspace member invite must return a member id');
  const memberBootstrap = await callFunction(baseUrl, workspaceMember.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    memberBootstrap?.workspace?.id === workspaceId &&
      Array.isArray(memberBootstrap?.pages) &&
      memberBootstrap.pages.some((page) => page.id === pageId),
    'workspace-bootstrap pageId must select the page workspace for workspace members',
  );
  assert(
    memberBootstrap?.pageRoles?.[pageId] === 'edit',
    'workspace-bootstrap must expose workspace member edit role for the selected page',
  );
  console.log('PASS workspace members can open direct page URLs in the correct workspace.');

  await expectFunctionStatus(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId,
  }, 403);
  console.log('PASS unshared viewer cannot read the private page.');

  const hiddenPageSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchPages',
    query: privatePageTitle,
  });
  assert(
    Array.isArray(hiddenPageSearch?.pages) &&
      !hiddenPageSearch.pages.some((page) => page.id === pageId),
    'searchPages must not leak unshared page titles',
  );
  const hiddenBlockSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchBlocks',
    query: privateBlockText,
  });
  assert(
    Array.isArray(hiddenBlockSearch?.blocks) &&
      !hiddenBlockSearch.blocks.some((block) => block.id === privateBlockId),
    'searchBlocks must not leak unshared page content',
  );
  console.log('PASS unshared viewer search cannot discover private page titles or block content.');

  await expectFunctionStatus(baseUrl, viewer.token, 'share-mutation', {
    action: 'get',
    pageId,
  }, 403);
  const ownerAccess = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(ownerAccess?.canManage === true, 'share access payload must mark owners as sharing managers');
  console.log('PASS share access reads are denied before page access and mark owners as managers.');

  const share = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewer.userId,
    label: 'Runtime smoke viewer',
    role: 'comment',
  });
  permissionId = share?.permission?.id;
  assert(permissionId, 'share invite must return a permission id');
  const viewerAccess = await callFunction(baseUrl, viewer.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(viewerAccess?.canManage === false, 'comment access must not manage page sharing');
  console.log('PASS owner can grant direct comment access to another user.');

  const emailShareAddress = `direct-page-share-${pageId}@example.com`;
  emailShareUser = await signUpWithPassword(
    baseUrl,
    emailShareAddress,
    `PermissionEmail${Date.now()}!aA1`,
    'Permission smoke email share',
  );
  const emailShare = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: emailShareAddress.toUpperCase(),
    role: 'comment',
  });
  emailPermissionId = emailShare?.permission?.id;
  assert(emailPermissionId, 'email share invite must return a permission id');
  assert(
    emailShare?.permission?.principalType === 'email' &&
      emailShare.permission.principalId === emailShareAddress,
    'email share invite must normalize and store the email principal id',
  );
  const emailBootstrap = await callFunction(baseUrl, emailShareUser.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    emailBootstrap?.workspace?.id === workspaceId,
    'workspace-bootstrap pageId must select the email-shared page workspace',
  );
  assert(
    !emailBootstrap?.currentMember,
    'email direct sharing must not silently turn the account into a workspace member',
  );
  assert(
    Array.isArray(emailBootstrap?.pages) &&
      emailBootstrap.pages.some((page) => page.id === pageId),
    'workspace-bootstrap pageId must include the email-shared page',
  );
  assert(
    emailBootstrap?.pageRoles?.[pageId] === 'comment',
    'workspace-bootstrap must expose email principal comment role for UI read-only state',
  );
  const emailSharedPage = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId,
  });
  assert(emailSharedPage?.page?.id === pageId, 'email principal permission must allow page reads');
  const emailSharedBlocks = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'blocks',
    pageId,
  });
  assert(
    Array.isArray(emailSharedBlocks?.blocks) &&
      emailSharedBlocks.blocks.some((block) => block.id === privateBlockId),
    'email principal permission must allow block reads',
  );
  const emailShareAccess = await callFunction(baseUrl, emailShareUser.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(emailShareAccess?.canManage === false, 'email comment access must not manage page sharing');
  emailCommentId = crypto.randomUUID();
  const emailComment = await callFunction(baseUrl, emailShareUser.token, 'comment-mutation', {
    action: 'create',
    id: emailCommentId,
    pageId,
    body: { rich: [{ text: 'Permission smoke email principal comment' }] },
  });
  assert(emailComment?.comment?.id === emailCommentId, 'email comment access must allow comments');
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Email comment role should not create blocks' }] },
    plainText: 'Email comment role should not create blocks',
    position: 2,
  }, 403);
  console.log('PASS email direct sharing binds to a signed-in account without workspace membership.');

  const viewShare = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: viewOnly.userId,
    label: 'Runtime smoke view-only user',
    role: 'view',
  });
  viewPermissionId = viewShare?.permission?.id;
  assert(viewPermissionId, 'view-only share invite must return a permission id');
  const viewOnlyPage = await callFunction(baseUrl, viewOnly.token, 'page-query', {
    action: 'page',
    pageId,
  });
  assert(viewOnlyPage?.page?.id === pageId, 'view-only page permission must allow page reads');
  const viewOnlyBootstrap = await callFunction(baseUrl, viewOnly.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    viewOnlyBootstrap?.pageRoles?.[pageId] === 'view',
    'workspace-bootstrap must expose direct view-only role for UI read-only state',
  );
  const viewOnlyAccess = await callFunction(baseUrl, viewOnly.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(viewOnlyAccess?.canManage === false, 'view-only access must not manage page sharing');
  await expectFunctionStatus(baseUrl, viewOnly.token, 'comment-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId,
    body: { rich: [{ text: 'View access should not comment' }] },
  }, 403);
  await expectFunctionStatus(baseUrl, viewOnly.token, 'page-mutation', {
    action: 'update',
    id: pageId,
    patch: { title: 'View access should not edit' },
  }, 403);
  await expectFunctionStatus(baseUrl, viewOnly.token, 'duplicate-page', {
    action: 'duplicate',
    pageId,
  }, 403);
  console.log('PASS direct view-only access allows reads but denies comments, edits, and duplication.');

  const fullAccessShare = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'user',
    principalId: fullAccessUser.userId,
    label: 'Runtime smoke full access user',
    role: 'full_access',
  });
  fullAccessPermissionId = fullAccessShare?.permission?.id;
  assert(fullAccessPermissionId, 'full access share invite must return a permission id');
  const fullAccessBootstrap = await callFunction(baseUrl, fullAccessUser.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    fullAccessBootstrap?.pageRoles?.[pageId] === 'full_access',
    'workspace-bootstrap must expose direct full access role for shared pages',
  );
  const fullAccessAccess = await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(fullAccessAccess?.canManage === true, 'full access must manage page sharing');
  // Full access on a page must still allow duplicating it in place: the gate
  // that closed the duplicate-page IDOR must not over-restrict real editors.
  const fullAccessDuplicate = await callFunction(baseUrl, fullAccessUser.token, 'duplicate-page', {
    action: 'duplicate',
    pageId,
  });
  const duplicatedPageId = fullAccessDuplicate?.page?.id;
  assert(
    typeof duplicatedPageId === 'string' && duplicatedPageId && duplicatedPageId !== pageId,
    'full access user must be able to duplicate a page they can edit',
  );
  await permanentlyDeletePage(baseUrl, owner.token, duplicatedPageId, { call: callFunction });
  console.log('PASS full-access share can duplicate an editable page in place.');
  const delegatedShare = await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: `full-access-delegate-${pageId}@example.test`,
    role: 'view',
  });
  delegatedPermissionId = delegatedShare?.permission?.id;
  assert(delegatedPermissionId, 'full access delegated invite must return a permission id');
  await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId: delegatedPermissionId,
    role: 'comment',
  });
  const removedDelegatedPermissionId = delegatedPermissionId;
  await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: delegatedPermissionId,
  });
  delegatedPermissionId = '';
  await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: true,
  });
  await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: false,
  });
  const permissionRevokeAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'page_permission.revoke',
    auditLimit: 10,
  });
  assert(
    permissionRevokeAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === removedDelegatedPermissionId &&
        event.actorId === fullAccessUser.userId &&
        event.metadata?.pageId === pageId,
    ),
    'page permission revokes must record filterable organization audit events',
  );
  const webSharingAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'share.web_update',
    auditLimit: 10,
  });
  assert(
    webSharingAudit?.organizationAuditEvents?.some(
      (event) =>
        event.targetId === pageId &&
        event.actorId === fullAccessUser.userId &&
        event.metadata?.enabled === false,
    ),
    'public web sharing changes must record filterable organization audit events',
  );
  console.log('PASS direct full access can manage page sharing permissions, web sharing, and audit events.');

  const groupGuestInvite = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'inviteMember',
    workspaceId,
    userId: groupAccessUser.userId,
    role: 'guest',
  });
  groupAccessWorkspaceMemberId = groupGuestInvite?.member?.id ?? '';
  assert(groupAccessWorkspaceMemberId, 'group access guest invite must return a workspace member id');
  const groupDirectory = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
  });
  const groupAccessOrganizationMember = groupDirectory?.organizationMembers?.find(
    (member) => member.userId === groupAccessUser.userId,
  );
  assert(groupAccessOrganizationMember?.id, 'group access user must appear in the organization directory');
  const organizationGroupName = `Permission smoke group ${crypto.randomUUID().slice(0, 8)}`;
  const createdOrganizationGroup = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'createOrganizationGroup',
    organizationId,
    name: organizationGroupName,
  });
  organizationGroupId = createdOrganizationGroup?.organizationGroups?.find(
    (group) => group.name === organizationGroupName,
  )?.id ?? '';
  assert(organizationGroupId, 'createOrganizationGroup must return the new organization group');
  const groupMemberAdded = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addOrganizationGroupMember',
    organizationId,
    organizationGroupId,
    organizationMemberId: groupAccessOrganizationMember.id,
  });
  organizationGroupMemberId = groupMemberAdded?.organizationGroups
    ?.find((group) => group.id === organizationGroupId)
    ?.members?.find((member) => member.organizationMemberId === groupAccessOrganizationMember.id)
    ?.id ?? '';
  assert(organizationGroupMemberId, 'addOrganizationGroupMember must return the new group membership');
  const groupAccessShare = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'group',
    principalId: organizationGroupId,
    label: organizationGroupName,
    role: 'full_access',
  });
  groupPermissionId = groupAccessShare?.permission?.id ?? '';
  assert(
    groupPermissionId &&
      groupAccessShare.permission.principalType === 'group' &&
      groupAccessShare.permission.principalId === organizationGroupId,
    'group page access must store a stable organization group principal',
  );
  const groupShareNotifications = await callFunction(baseUrl, groupAccessUser.token, 'notification-mutation', {
    action: 'list',
    workspaceId,
    includeRead: true,
  });
  assert(
    groupShareNotifications?.notifications?.some(
      (notification) =>
        notification.kind === 'system' &&
        notification.metadata?.source === 'share' &&
        notification.metadata?.principalType === 'group' &&
        notification.metadata?.permissionId === groupPermissionId,
    ),
    'group page access must notify active group members',
  );
  const groupAccessBootstrap = await callFunction(baseUrl, groupAccessUser.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    groupAccessBootstrap?.pageRoles?.[pageId] === 'full_access',
    'workspace-bootstrap must expose group full access over a guest workspace role',
  );
  const groupAccessPayload = await callFunction(baseUrl, groupAccessUser.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(groupAccessPayload?.canManage === true, 'group full access must manage page sharing');
  groupAccessBlockId = crypto.randomUUID();
  const groupAccessBlock = await callFunction(baseUrl, groupAccessUser.token, 'block-mutation', {
    action: 'create',
    id: groupAccessBlockId,
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Permission smoke group full access block' }] },
    plainText: 'Permission smoke group full access block',
    position: 2,
  });
  assert(groupAccessBlock?.block?.id === groupAccessBlockId, 'group full access must allow inherited page content edits');
  const delegatedGroupShare = await callFunction(baseUrl, groupAccessUser.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: `group-full-access-delegate-${pageId}@example.test`,
    role: 'view',
  });
  delegatedGroupPermissionId = delegatedGroupShare?.permission?.id ?? '';
  assert(delegatedGroupPermissionId, 'group full access delegated invite must return a permission id');
  await callFunction(baseUrl, groupAccessUser.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: delegatedGroupPermissionId,
  });
  delegatedGroupPermissionId = '';
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationGroupMember',
    organizationId,
    organizationGroupId,
    organizationGroupMemberId,
  });
  organizationGroupMemberId = '';
  const groupAccessAfterRemoval = await callFunction(baseUrl, groupAccessUser.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    groupAccessAfterRemoval?.pageRoles?.[pageId] === 'view',
    'removing a user from a group must remove the elevated group page role',
  );
  const groupAccessPayloadAfterRemoval = await callFunction(baseUrl, groupAccessUser.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(groupAccessPayloadAfterRemoval?.canManage === false, 'removed group members must lose group share management');
  await expectFunctionStatus(baseUrl, groupAccessUser.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Removed group member should not edit' }] },
    plainText: 'Removed group member should not edit',
    position: 3,
  }, 403);
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: groupPermissionId,
  });
  groupPermissionId = '';
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'deleteOrganizationGroup',
    organizationId,
    organizationGroupId,
  });
  organizationGroupId = '';
  console.log('PASS organization group page access grants, delegates, and revokes inherited full access.');

  const sharedPage = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId,
  });
  assert(sharedPage?.page?.id === pageId, 'direct page permission must allow page-query page reads');

  const visiblePages = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'pages',
    workspaceId,
  });
  assert(
    Array.isArray(visiblePages?.pages) && visiblePages.pages.some((page) => page.id === pageId),
    'direct page permission must include the shared page in page-query pages',
  );
  console.log('PASS directly shared viewer can read the shared page projection.');

  const sharedPageSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchPages',
    query: privatePageTitle,
  });
  assert(
    Array.isArray(sharedPageSearch?.pages) &&
      sharedPageSearch.pages.some((page) => page.id === pageId),
    'searchPages must include directly shared pages',
  );
  const sharedBlockSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchBlocks',
    query: privateBlockText,
  });
  assert(
    Array.isArray(sharedBlockSearch?.blocks) &&
      sharedBlockSearch.blocks.some((block) => block.id === privateBlockId),
    'searchBlocks must include blocks from directly shared pages',
  );
  console.log('PASS shared viewer search can discover only newly accessible page titles and block content.');

  const sharedBootstrap = await callFunction(baseUrl, viewer.token, 'workspace-bootstrap', {
    pageId,
  });
  assert(
    sharedBootstrap?.workspace?.id === workspaceId,
    'workspace-bootstrap pageId must select the shared page workspace',
  );
  assert(
    !sharedBootstrap?.currentMember,
    'direct page sharing must not silently turn the viewer into a workspace member',
  );
  assert(
    Array.isArray(sharedBootstrap?.pages) &&
      sharedBootstrap.pages.some((page) => page.id === pageId),
    'workspace-bootstrap pageId must include the shared page',
  );
  assert(
    sharedBootstrap?.pageRoles?.[pageId] === 'comment',
    'workspace-bootstrap must expose direct comment role for UI read-only state',
  );
  console.log('PASS bootstrap can open a directly shared page without workspace membership.');

  commentId = crypto.randomUUID();
  const comment = await callFunction(baseUrl, viewer.token, 'comment-mutation', {
    action: 'create',
    id: commentId,
    pageId,
    body: { rich: [{ text: 'Permission smoke comment' }] },
  });
  assert(comment?.comment?.id === commentId, 'comment access must allow viewer comments');
  console.log('PASS comment-level direct access allows comments.');

  childPageId = crypto.randomUUID();
  const child = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: childPageId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    kind: 'page',
    title: 'Permission smoke child',
    position: Date.now() + 1,
  });
  assert(child?.page?.id === childPageId, 'owner must be able to create a child page');

  const sharedChild = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId: childPageId,
  });
  assert(sharedChild?.page?.id === childPageId, 'parent permission must allow child page reads');

  const childBootstrap = await callFunction(baseUrl, viewer.token, 'workspace-bootstrap', {
    pageId: childPageId,
  });
  assert(
    Array.isArray(childBootstrap?.pages) &&
      childBootstrap.pages.some((page) => page.id === pageId) &&
      childBootstrap.pages.some((page) => page.id === childPageId),
    'workspace-bootstrap child pageId must include the shared parent subtree',
  );
  assert(
    childBootstrap?.pageRoles?.[pageId] === 'comment' &&
      childBootstrap?.pageRoles?.[childPageId] === 'comment',
    'workspace-bootstrap must expose inherited comment roles for shared child pages',
  );
  const inheritedFullAccess = await callFunction(baseUrl, fullAccessUser.token, 'share-mutation', {
    action: 'get',
    pageId: childPageId,
  });
  assert(
    inheritedFullAccess?.canManage === true,
    'inherited full access must manage child page sharing',
  );
  const childFullAccessBootstrap = await callFunction(baseUrl, fullAccessUser.token, 'workspace-bootstrap', {
    pageId: childPageId,
  });
  assert(
    childFullAccessBootstrap?.pageRoles?.[pageId] === 'full_access' &&
      childFullAccessBootstrap?.pageRoles?.[childPageId] === 'full_access',
    'workspace-bootstrap must expose inherited full access roles for shared child pages',
  );

  childCommentId = crypto.randomUUID();
  const childComment = await callFunction(baseUrl, viewer.token, 'comment-mutation', {
    action: 'create',
    id: childCommentId,
    pageId: childPageId,
    body: { rich: [{ text: 'Permission smoke inherited child comment' }] },
  });
  assert(childComment?.comment?.id === childCommentId, 'parent comment permission must allow child comments');
  console.log('PASS parent comment and full access roles are inherited by child pages.');

  databaseId = crypto.randomUUID();
  const database = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: databaseId,
    workspaceId,
    parentId: pageId,
    parentType: 'page',
    kind: 'database',
    title: 'Permission smoke database',
    position: Date.now() + 2,
  });
  assert(database?.page?.id === databaseId, 'owner must be able to create a child database');

  dbPropertyId = crypto.randomUUID();
  const dbProperty = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: dbPropertyId,
      databaseId,
      name: 'Summary',
      type: 'rich_text',
      position: 1,
    },
  });
  assert(dbProperty?.record?.id === dbPropertyId, 'owner must be able to create database properties');

  dbViewId = crypto.randomUUID();
  const dbView = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: dbViewId,
      databaseId,
      name: 'Main table',
      type: 'table',
      config: { visiblePropertyIds: [dbPropertyId] },
      position: 1,
    },
  });
  assert(dbView?.record?.id === dbViewId, 'owner must be able to create database views');

  dbTemplateId = crypto.randomUUID();
  const dbTemplate = await callFunction(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_templates',
    record: {
      id: dbTemplateId,
      databaseId,
      name: 'Owner template',
      title: 'Templated owner row',
      properties: {
        [dbPropertyId]: 'templated summary',
      },
      blocks: [
        {
          type: 'paragraph',
          content: { rich: [{ text: ownerRowBlockText }] },
        },
      ],
      isDefault: false,
      position: 1,
    },
  });
  assert(dbTemplate?.record?.id === dbTemplateId, 'owner must be able to create database templates');

  ownerRowId = crypto.randomUUID();
  const ownerRow = await callFunction(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: ownerRowId,
    databaseId,
    templateId: dbTemplateId,
    title: ownerRowTitle,
    properties: {
      [dbPropertyId]: 'owner value',
    },
  });
  assert(ownerRow?.row?.id === ownerRowId, 'owner must be able to create database rows');
  ownerRowBlockId = ownerRow.blocks?.[0]?.id ?? '';
  assert(ownerRowBlockId, 'owner row created from a template must include a row page block');

  const dbSnapshot = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'database',
    databaseId,
  });
  assert(
    Array.isArray(dbSnapshot?.properties) &&
      dbSnapshot.properties.some((property) => property.id === dbPropertyId),
    'parent permission must allow database schema reads',
  );
  assert(
    Array.isArray(dbSnapshot?.views) &&
      dbSnapshot.views.some((view) => view.id === dbViewId),
    'parent permission must allow database view reads',
  );
  assert(
    Array.isArray(dbSnapshot?.templates) &&
      dbSnapshot.templates.some((template) => template.id === dbTemplateId),
    'parent permission must allow database template reads',
  );

  const dbRows = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  });
  assert(
    Array.isArray(dbRows?.rows) && dbRows.rows.some((row) => row.id === ownerRowId),
    'parent permission must allow database row reads',
  );
  const sharedRowPage = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId: ownerRowId,
  });
  assert(sharedRowPage?.page?.id === ownerRowId, 'parent permission must allow direct row page reads');
  const sharedRowBlocks = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'blocks',
    pageId: ownerRowId,
  });
  assert(
    Array.isArray(sharedRowBlocks?.blocks) &&
      sharedRowBlocks.blocks.some((block) => block.id === ownerRowBlockId && block.plainText === ownerRowBlockText),
    'parent permission must allow direct row page block reads',
  );
  const sharedRowPageSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchPages',
    query: ownerRowTitle,
  });
  assert(
    Array.isArray(sharedRowPageSearch?.pages) &&
      sharedRowPageSearch.pages.some((page) => page.id === ownerRowId),
    'searchPages must include directly shared database row pages',
  );
  const sharedRowBlockSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchBlocks',
    query: ownerRowBlockText,
  });
  assert(
    Array.isArray(sharedRowBlockSearch?.blocks) &&
      sharedRowBlockSearch.blocks.some((block) => block.id === ownerRowBlockId),
    'searchBlocks must include blocks from directly shared database row pages',
  );
  console.log('PASS inherited comment access allows database schema, row page, row block, and row search reads.');

  const emailSharedChild = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId: childPageId,
  });
  assert(emailSharedChild?.page?.id === childPageId, 'email principal parent permission must allow child page reads');
  const emailDbSnapshot = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'database',
    databaseId,
  });
  assert(
    Array.isArray(emailDbSnapshot?.properties) &&
      emailDbSnapshot.properties.some((property) => property.id === dbPropertyId),
    'email principal parent permission must allow database schema reads',
  );
  assert(
    Array.isArray(emailDbSnapshot?.views) &&
      emailDbSnapshot.views.some((view) => view.id === dbViewId),
    'email principal parent permission must allow database view reads',
  );
  assert(
    Array.isArray(emailDbSnapshot?.templates) &&
      emailDbSnapshot.templates.some((template) => template.id === dbTemplateId),
    'email principal parent permission must allow database template reads',
  );
  const emailDbRows = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  });
  assert(
    Array.isArray(emailDbRows?.rows) && emailDbRows.rows.some((row) => row.id === ownerRowId),
    'email principal parent permission must allow database row reads',
  );
  const emailRowPage = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId: ownerRowId,
  });
  assert(emailRowPage?.page?.id === ownerRowId, 'email principal parent permission must allow row page reads');
  const emailRowBlocks = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'blocks',
    pageId: ownerRowId,
  });
  assert(
    Array.isArray(emailRowBlocks?.blocks) &&
      emailRowBlocks.blocks.some((block) => block.id === ownerRowBlockId && block.plainText === ownerRowBlockText),
    'email principal parent permission must allow row page block reads',
  );
  const emailRowPageSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchPages',
    query: ownerRowTitle,
  });
  assert(
    Array.isArray(emailRowPageSearch?.pages) &&
      emailRowPageSearch.pages.some((page) => page.id === ownerRowId),
    'email principal searchPages must include inherited database row pages',
  );
  const emailRowBlockSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchBlocks',
    query: ownerRowBlockText,
  });
  assert(
    Array.isArray(emailRowBlockSearch?.blocks) &&
      emailRowBlockSearch.blocks.some((block) => block.id === ownerRowBlockId),
    'email principal searchBlocks must include inherited database row page blocks',
  );
  const emailDbBootstrap = await callFunction(baseUrl, emailShareUser.token, 'workspace-bootstrap', {
    pageId: ownerRowId,
  });
  assert(
    !emailDbBootstrap?.currentMember,
    'email principal inherited database bootstrap must not create workspace membership',
  );
  assert(
    emailDbBootstrap?.pageRoles?.[pageId] === 'comment' &&
      emailDbBootstrap?.pageRoles?.[childPageId] === 'comment' &&
      emailDbBootstrap?.pageRoles?.[databaseId] === 'comment' &&
      emailDbBootstrap?.pageRoles?.[ownerRowId] === 'comment',
    'workspace-bootstrap must expose inherited email-principal comment roles for child/database row pages',
  );
  emailChildCommentId = crypto.randomUUID();
  const emailChildComment = await callFunction(baseUrl, emailShareUser.token, 'comment-mutation', {
    action: 'create',
    id: emailChildCommentId,
    pageId: childPageId,
    body: { rich: [{ text: 'Permission smoke email inherited child comment' }] },
  });
  assert(
    emailChildComment?.comment?.id === emailChildCommentId,
    'email principal parent comment permission must allow child page comments',
  );
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    title: 'Email comment role should not create rows',
  }, 403);
  console.log('PASS email principal inherited comment access allows child/database reads without workspace membership.');

  const viewOnlyDbSnapshot = await callFunction(baseUrl, viewOnly.token, 'page-query', {
    action: 'database',
    databaseId,
  });
  assert(
    Array.isArray(viewOnlyDbSnapshot?.properties) &&
      viewOnlyDbSnapshot.properties.some((property) => property.id === dbPropertyId),
    'view-only inherited permission must allow database schema reads',
  );
  const viewOnlyDbRows = await callFunction(baseUrl, viewOnly.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  });
  assert(
    Array.isArray(viewOnlyDbRows?.rows) && viewOnlyDbRows.rows.some((row) => row.id === ownerRowId),
    'view-only inherited permission must allow database row reads',
  );
  const viewOnlyRowPage = await callFunction(baseUrl, viewOnly.token, 'page-query', {
    action: 'page',
    pageId: ownerRowId,
  });
  assert(viewOnlyRowPage?.page?.id === ownerRowId, 'view-only inherited permission must allow direct row page reads');
  const viewOnlyRowBlocks = await callFunction(baseUrl, viewOnly.token, 'page-query', {
    action: 'blocks',
    pageId: ownerRowId,
  });
  assert(
    Array.isArray(viewOnlyRowBlocks?.blocks) &&
      viewOnlyRowBlocks.blocks.some((block) => block.id === ownerRowBlockId),
    'view-only inherited permission must allow direct row page block reads',
  );
  const viewOnlyDbBootstrap = await callFunction(baseUrl, viewOnly.token, 'workspace-bootstrap', {
    pageId: ownerRowId,
  });
  assert(
    viewOnlyDbBootstrap?.pageRoles?.[pageId] === 'view' &&
      viewOnlyDbBootstrap?.pageRoles?.[databaseId] === 'view' &&
      viewOnlyDbBootstrap?.pageRoles?.[ownerRowId] === 'view',
    'workspace-bootstrap must expose inherited view-only roles for shared database rows',
  );
  await expectFunctionStatus(baseUrl, viewOnly.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'View role should not create blocks' }] },
    plainText: 'View role should not create blocks',
    position: 1,
  }, 403);
  await expectFunctionStatus(baseUrl, viewOnly.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    title: 'View role should not create rows',
  }, 403);
  await expectFunctionStatus(baseUrl, viewOnly.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId,
      name: 'Blocked view schema insert',
      type: 'rich_text',
      position: 98,
    },
  }, 403);
  console.log('PASS inherited view-only access allows database reads but denies content and schema edits.');

  await expectFunctionStatus(baseUrl, viewer.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Comment role should not create blocks' }] },
    plainText: 'Comment role should not create blocks',
    position: 1,
  }, 403);
  console.log('PASS inherited comment access does not allow child block edits.');

  await expectFunctionStatus(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    title: 'Comment role should not create rows',
    properties: {
      [dbPropertyId]: 'blocked',
    },
  }, 403);
  console.log('PASS inherited comment access does not allow database row edits.');

  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId,
      name: 'Blocked comment schema insert',
      type: 'rich_text',
      position: 99,
    },
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'update',
    table: 'db_properties',
    id: dbPropertyId,
    databaseId,
    patch: { name: 'Blocked comment schema update' },
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'delete',
    table: 'db_views',
    id: dbViewId,
    databaseId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: crypto.randomUUID(),
      databaseId,
      name: 'Blocked comment view insert',
      type: 'table',
      position: 99,
    },
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'update',
    table: 'db_templates',
    id: dbTemplateId,
    databaseId,
    patch: { title: 'Blocked comment template update' },
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'database-mutation', {
    action: 'delete',
    table: 'db_templates',
    id: dbTemplateId,
    databaseId,
  }, 403);
  console.log('PASS inherited comment access does not allow database schema, view, or template mutations.');

  await expectFunctionStatus(baseUrl, viewer.token, 'page-mutation', {
    action: 'update',
    id: pageId,
    patch: { title: 'Comment role should not edit' },
  }, 403);
  console.log('PASS comment-level access does not allow page edits.');

  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'update',
    id: databaseId,
    patch: { isLocked: true },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: crypto.randomUUID(),
      databaseId,
      name: 'Locked schema insert',
      type: 'rich_text',
      position: 100,
    },
  }, 423);
  await expectFunctionStatus(baseUrl, owner.token, 'database-row-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    databaseId,
    title: 'Locked row insert',
  }, 423);
  await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'update',
    id: databaseId,
    patch: { isLocked: false },
  });
  console.log('PASS locked databases block schema and row writes even for the owner.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId,
    role: 'edit',
  });
  const editBootstrap = await callFunction(baseUrl, viewer.token, 'workspace-bootstrap', {
    pageId: databaseId,
  });
  assert(
    editBootstrap?.pageRoles?.[pageId] === 'edit' &&
      editBootstrap?.pageRoles?.[childPageId] === 'edit' &&
      editBootstrap?.pageRoles?.[databaseId] === 'edit',
    'workspace-bootstrap must expose upgraded inherited edit roles',
  );
  const editAccess = await callFunction(baseUrl, viewer.token, 'share-mutation', {
    action: 'get',
    pageId,
  });
  assert(editAccess?.canManage === false, 'edit access must not manage page sharing');
  await expectFunctionStatus(baseUrl, viewer.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId,
    enabled: true,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'share-mutation', {
    action: 'invite',
    pageId,
    principalType: 'email',
    label: `shared-editor-${pageId}@example.test`,
    role: 'view',
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'share-mutation', {
    action: 'updatePermission',
    permissionId,
    role: 'comment',
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'share-mutation', {
    action: 'removePermission',
    permissionId,
  }, 403);
  console.log('PASS edit access cannot manage page sharing permissions.');

  const edited = await callFunction(baseUrl, viewer.token, 'page-mutation', {
    action: 'update',
    id: pageId,
    patch: { title: 'Permission smoke edited by shared user' },
  });
  assert(edited?.page?.title === 'Permission smoke edited by shared user', 'edit access must allow page edits');

  childBlockId = crypto.randomUUID();
  const childBlock = await callFunction(baseUrl, viewer.token, 'block-mutation', {
    action: 'create',
    id: childBlockId,
    pageId: childPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Permission smoke inherited child block' }] },
    plainText: 'Permission smoke inherited child block',
    position: 1,
  });
  assert(childBlock?.block?.id === childBlockId, 'parent edit permission must allow child block edits');

  viewerRowId = crypto.randomUUID();
  const viewerRow = await callFunction(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'create',
    id: viewerRowId,
    databaseId,
    title: 'Viewer row',
    properties: {
      [dbPropertyId]: 'viewer value',
    },
  });
  assert(viewerRow?.row?.id === viewerRowId, 'parent edit permission must allow database row edits');
  const updatedViewerRow = await callFunction(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'update',
    id: viewerRowId,
    patch: {
      title: 'Viewer row updated',
      properties: {
        [dbPropertyId]: 'viewer updated value',
      },
    },
  });
  assert(
    updatedViewerRow?.row?.title === 'Viewer row updated' &&
      updatedViewerRow.row.properties?.[dbPropertyId] === 'viewer updated value',
    'parent edit permission must allow database row title and property updates',
  );
  const movedViewerRow = await callFunction(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'move',
    id: viewerRowId,
    targetId: ownerRowId,
    side: 'before',
  });
  assert(
    movedViewerRow?.row?.id === viewerRowId &&
      movedViewerRow.row.position < ownerRow.row.position,
    'parent edit permission must allow database row moves',
  );
  const trashedViewerRow = await callFunction(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'trash',
    id: viewerRowId,
  });
  assert(
    trashedViewerRow?.row?.id === viewerRowId && trashedViewerRow.row.inTrash === true,
    'parent edit permission must allow database row trash',
  );
  const restoredViewerRow = await callFunction(baseUrl, viewer.token, 'database-row-mutation', {
    action: 'restore',
    id: viewerRowId,
  });
  assert(
    restoredViewerRow?.row?.id === viewerRowId && restoredViewerRow.row.inTrash !== true,
    'parent edit permission must allow database row restore',
  );

  viewerSchemaPropertyId = crypto.randomUUID();
  const viewerProperty = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'insert',
    table: 'db_properties',
    record: {
      id: viewerSchemaPropertyId,
      databaseId,
      name: 'Viewer schema property',
      type: 'checkbox',
      position: 2,
    },
  });
  assert(viewerProperty?.record?.id === viewerSchemaPropertyId, 'edit access must allow database property creation');
  const viewerPropertyUpdate = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'update',
    table: 'db_properties',
    id: viewerSchemaPropertyId,
    databaseId,
    patch: { name: 'Viewer schema property updated' },
  });
  assert(
    viewerPropertyUpdate?.record?.name === 'Viewer schema property updated',
    'edit access must allow database property updates',
  );

  viewerSchemaViewId = crypto.randomUUID();
  const viewerView = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'insert',
    table: 'db_views',
    record: {
      id: viewerSchemaViewId,
      databaseId,
      name: 'Viewer view',
      type: 'list',
      config: { visiblePropertyIds: [dbPropertyId, viewerSchemaPropertyId] },
      position: 2,
    },
  });
  assert(viewerView?.record?.id === viewerSchemaViewId, 'edit access must allow database view creation');
  const viewerViewUpdate = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'update',
    table: 'db_views',
    id: viewerSchemaViewId,
    databaseId,
    patch: { name: 'Viewer view updated' },
  });
  assert(viewerViewUpdate?.record?.name === 'Viewer view updated', 'edit access must allow database view updates');
  await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'delete',
    table: 'db_views',
    id: viewerSchemaViewId,
    databaseId,
  });
  viewerSchemaViewId = '';

  viewerSchemaTemplateId = crypto.randomUUID();
  const viewerTemplate = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'insert',
    table: 'db_templates',
    record: {
      id: viewerSchemaTemplateId,
      databaseId,
      name: 'Viewer template',
      title: 'Viewer templated row',
      properties: {
        [dbPropertyId]: 'viewer template value',
        [viewerSchemaPropertyId]: true,
      },
      blocks: [
        {
          type: 'heading_2',
          content: { rich: [{ text: 'Viewer template heading' }] },
        },
      ],
      isDefault: false,
      position: 2,
    },
  });
  assert(viewerTemplate?.record?.id === viewerSchemaTemplateId, 'edit access must allow database template creation');
  const viewerTemplateUpdate = await callFunction(baseUrl, viewer.token, 'database-mutation', {
    action: 'update',
    table: 'db_templates',
    id: viewerSchemaTemplateId,
    databaseId,
    patch: { title: 'Viewer templated row updated' },
  });
  assert(
    viewerTemplateUpdate?.record?.title === 'Viewer templated row updated',
    'edit access must allow database template updates',
  );
  console.log('PASS upgraded edit access is inherited by child page block, database row lifecycle, and database schema edits.');

  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId,
  });
  permissionId = '';
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: viewPermissionId,
  });
  viewPermissionId = '';
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: fullAccessPermissionId,
  });
  fullAccessPermissionId = '';
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'removePermission',
    permissionId: emailPermissionId,
  });
  emailPermissionId = '';
  await expectFunctionStatus(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewOnly.token, 'page-query', {
    action: 'page',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'page-query', {
    action: 'page',
    pageId: ownerRowId,
  }, 403);
  await expectFunctionStatus(baseUrl, viewer.token, 'page-query', {
    action: 'blocks',
    pageId: ownerRowId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'workspace-bootstrap', {
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'blocks',
    pageId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId: childPageId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'databaseRows',
    databaseId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'page',
    pageId: ownerRowId,
  }, 403);
  await expectFunctionStatus(baseUrl, emailShareUser.token, 'page-query', {
    action: 'blocks',
    pageId: ownerRowId,
  }, 403);

  const revokedPageSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchPages',
    query: privatePageTitle,
  });
  assert(
    Array.isArray(revokedPageSearch?.pages) &&
      !revokedPageSearch.pages.some((page) => page.id === pageId),
    'searchPages must stop returning a page after direct access is revoked',
  );
  const revokedBlockSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchBlocks',
    query: privateBlockText,
  });
  assert(
    Array.isArray(revokedBlockSearch?.blocks) &&
      !revokedBlockSearch.blocks.some((block) => block.id === privateBlockId),
    'searchBlocks must stop returning page content after direct access is revoked',
  );
  const revokedRowPageSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchPages',
    query: ownerRowTitle,
  });
  assert(
    Array.isArray(revokedRowPageSearch?.pages) &&
      !revokedRowPageSearch.pages.some((page) => page.id === ownerRowId),
    'searchPages must stop returning database row pages after inherited direct access is revoked',
  );
  const revokedRowBlockSearch = await callFunction(baseUrl, viewer.token, 'page-query', {
    action: 'searchBlocks',
    query: ownerRowBlockText,
  });
  assert(
    Array.isArray(revokedRowBlockSearch?.blocks) &&
      !revokedRowBlockSearch.blocks.some((block) => block.id === ownerRowBlockId),
    'searchBlocks must stop returning database row page blocks after inherited direct access is revoked',
  );
  const revokedEmailPageSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchPages',
    query: privatePageTitle,
  });
  assert(
    Array.isArray(revokedEmailPageSearch?.pages) &&
      !revokedEmailPageSearch.pages.some((page) => page.id === pageId),
    'searchPages must stop returning pages after email principal access is revoked',
  );
  const revokedEmailBlockSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchBlocks',
    query: privateBlockText,
  });
  assert(
    Array.isArray(revokedEmailBlockSearch?.blocks) &&
      !revokedEmailBlockSearch.blocks.some((block) => block.id === privateBlockId),
    'searchBlocks must stop returning page content after email principal access is revoked',
  );
  const revokedEmailRowPageSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchPages',
    query: ownerRowTitle,
  });
  assert(
    Array.isArray(revokedEmailRowPageSearch?.pages) &&
      !revokedEmailRowPageSearch.pages.some((page) => page.id === ownerRowId),
    'searchPages must stop returning inherited row pages after email principal access is revoked',
  );
  const revokedEmailRowBlockSearch = await callFunction(baseUrl, emailShareUser.token, 'page-query', {
    action: 'searchBlocks',
    query: ownerRowBlockText,
  });
  assert(
    Array.isArray(revokedEmailRowBlockSearch?.blocks) &&
      !revokedEmailRowBlockSearch.blocks.some((block) => block.id === ownerRowBlockId),
    'searchBlocks must stop returning inherited row blocks after email principal access is revoked',
  );
  console.log('PASS removing direct access blocks user and email-principal page/database reads again.');

  const deleted = await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction });
  const deletedIds = new Set(deleted?.deletedIds ?? []);
  for (const expectedId of [pageId, childPageId, databaseId, ownerRowId, viewerRowId]) {
    assert(deletedIds.has(expectedId), `permanent delete must include page subtree id ${expectedId}`);
  }
  assert(deleted?.cleanup?.blocks >= 1, 'permanent delete must clean page blocks');
  assert(deleted?.cleanup?.comments >= 2, 'permanent delete must clean page comments');
  assert(deleted?.cleanup?.databaseProperties >= 2, 'permanent delete must clean database properties');
  assert(deleted?.cleanup?.databaseViews >= 1, 'permanent delete must clean database views');
  assert(deleted?.cleanup?.databaseTemplates >= 2, 'permanent delete must clean database templates');
  assert(
    typeof deleted?.cleanup?.collaborationOperations === 'number',
    'permanent delete must report collaboration operation cleanup',
  );
  console.log('PASS permanent page delete cleans child pages, rows, blocks, comments, collaboration logs, and database metadata.');
  pageId = '';
  childPageId = '';
  databaseId = '';
  ownerRowId = '';
  viewerRowId = '';
  dbPropertyId = '';
  dbViewId = '';
  dbTemplateId = '';
  viewerSchemaPropertyId = '';
  viewerSchemaViewId = '';
  viewerSchemaTemplateId = '';
  commentId = '';
  childCommentId = '';
  emailCommentId = '';
  emailChildCommentId = '';
  privateBlockId = '';
  childBlockId = '';
  groupAccessBlockId = '';
  emailPermissionId = '';

  console.log('\nPASS multi-user page and database permission flow works through product APIs.');
}

async function cleanupResources() {
  if (!owner?.token) return;
  const baseUrl = normalizeBaseUrl(options.url);

  if (delegatedPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: delegatedPermissionId,
    }).catch(() => {});
    delegatedPermissionId = '';
  }

  if (delegatedGroupPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: delegatedGroupPermissionId,
    }).catch(() => {});
    delegatedGroupPermissionId = '';
  }

  if (groupPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: groupPermissionId,
    }).catch(() => {});
    groupPermissionId = '';
  }

  if (organizationGroupMemberId && organizationGroupId && organizationId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'removeOrganizationGroupMember',
      organizationId,
      organizationGroupId,
      organizationGroupMemberId,
    }).catch(() => {});
    organizationGroupMemberId = '';
  }

  if (organizationGroupId && organizationId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'deleteOrganizationGroup',
      organizationId,
      organizationGroupId,
    }).catch(() => {});
    organizationGroupId = '';
  }

  if (fullAccessPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: fullAccessPermissionId,
    }).catch(() => {});
    fullAccessPermissionId = '';
  }

  if (emailPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: emailPermissionId,
    }).catch(() => {});
    emailPermissionId = '';
  }

  if (permissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId,
    }).catch(() => {});
    permissionId = '';
  }

  if (viewPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: viewPermissionId,
    }).catch(() => {});
    viewPermissionId = '';
  }

  if (workspaceMemberId && workspaceId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'removeMember',
      workspaceId,
      memberId: workspaceMemberId,
    }).catch(() => {});
    workspaceMemberId = '';
  }

  if (groupAccessWorkspaceMemberId && workspaceId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'removeMember',
      workspaceId,
      memberId: groupAccessWorkspaceMemberId,
    }).catch(() => {});
    groupAccessWorkspaceMemberId = '';
  }

  if (commentId) {
    await callFunction(baseUrl, owner.token, 'comment-mutation', {
      action: 'delete',
      id: commentId,
    }).catch(() => {});
    commentId = '';
  }

  if (childCommentId) {
    await callFunction(baseUrl, owner.token, 'comment-mutation', {
      action: 'delete',
      id: childCommentId,
    }).catch(() => {});
    childCommentId = '';
  }

  if (emailCommentId) {
    await callFunction(baseUrl, owner.token, 'comment-mutation', {
      action: 'delete',
      id: emailCommentId,
    }).catch(() => {});
    emailCommentId = '';
  }

  if (emailChildCommentId) {
    await callFunction(baseUrl, owner.token, 'comment-mutation', {
      action: 'delete',
      id: emailChildCommentId,
    }).catch(() => {});
    emailChildCommentId = '';
  }

  if (childBlockId) {
    await callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'delete',
      id: childBlockId,
    }).catch(() => {});
    childBlockId = '';
  }

  if (groupAccessBlockId) {
    await callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'delete',
      id: groupAccessBlockId,
    }).catch(() => {});
    groupAccessBlockId = '';
  }

  if (privateBlockId) {
    await callFunction(baseUrl, owner.token, 'block-mutation', {
      action: 'delete',
      id: privateBlockId,
    }).catch(() => {});
    privateBlockId = '';
  }

  if (viewerRowId) {
    await permanentlyDeleteDatabaseRow(baseUrl, owner.token, viewerRowId, { call: callFunction }).catch(() => {});
    viewerRowId = '';
  }

  if (ownerRowId) {
    await permanentlyDeleteDatabaseRow(baseUrl, owner.token, ownerRowId, { call: callFunction }).catch(() => {});
    ownerRowId = '';
  }

  if (databaseId) {
    await callFunction(baseUrl, owner.token, 'page-mutation', {
      action: 'update',
      id: databaseId,
      patch: { isLocked: false },
    }).catch(() => {});
  }

  for (const [table, id] of [
    ['db_views', viewerSchemaViewId],
    ['db_templates', viewerSchemaTemplateId],
    ['db_templates', dbTemplateId],
    ['db_properties', viewerSchemaPropertyId],
    ['db_views', dbViewId],
    ['db_properties', dbPropertyId],
  ]) {
    if (!id) continue;
    await callFunction(baseUrl, owner.token, 'database-mutation', {
      action: 'delete',
      table,
      id,
      databaseId,
    }).catch(() => {});
  }
  viewerSchemaViewId = '';
  viewerSchemaTemplateId = '';
  dbTemplateId = '';
  viewerSchemaPropertyId = '';
  dbViewId = '';
  dbPropertyId = '';

  if (pageId) {
    await permanentlyDeletePage(baseUrl, owner.token, pageId, { call: callFunction }).catch(() => {});
    pageId = '';
  }
}

async function cleanup() {
  const failures = [];
  await cleanupResources().catch((error) => failures.push(error));
  await cleanupPasswordAccounts().catch((error) => failures.push(error));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Multi-user permission smoke cleanup was incomplete.');
  }
}

async function cleanupPasswordAccounts() {
  if (!emailShareUser?.token || !emailShareUser?.userId) return;
  const baseUrl = normalizeBaseUrl(options.url);
  const adminToken = await signInMaster(baseUrl);
  await deleteSmokeAccounts(baseUrl, adminToken, [emailShareUser], { call: callFunction });
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
  console.log(`Usage: node scripts/multi-user-permission-smoke.mjs [options]

Checks direct page sharing, inherited child page/database access, comments,
edit upgrades, and permission removal against a running Hanji EdgeBase
runtime.

Options:
  --url <url>             Runtime URL. Defaults to HANJI_EDGEBASE_URL or http://127.0.0.1:8787.
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

async function signUpWithPassword(baseUrl, email, password, displayName) {
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      email,
      password,
      data: displayName ? { displayName } : undefined,
    }),
  });
  const body = await readJson(response);
  assert(response.status === 201 || response.ok, `password signup returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  const token = body?.accessToken;
  const userId = body?.user?.id;
  assert(typeof token === 'string' && token, 'password signup must return an access token');
  assert(typeof userId === 'string' && userId, 'password signup must return a user id');
  return { token, userId, email, password };
}

async function signInMaster(baseUrl) {
  const credentials = masterCredentials();
  const response = await fetchWithTimeout(resolveUrl(baseUrl, '/api/auth/signin'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(credentials),
  });
  const body = await readJson(response);
  assert(response.ok, `master sign-in returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  assert(typeof body?.accessToken === 'string' && body.accessToken, 'master sign-in must return an access token');
  return body.accessToken;
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
    throw new Error(
      `${name} expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
