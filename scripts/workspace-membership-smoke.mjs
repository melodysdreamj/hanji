#!/usr/bin/env node

import {
  deleteSmokeAccounts,
  masterCredentials,
  permanentlyDeletePage,
} from './lib/harness.mjs';

const DEFAULT_BASE_URL = process.env.HANJI_EDGEBASE_URL ?? 'http://127.0.0.1:8787';
const DEFAULT_TIMEOUT_MS = 8_000;

const options = parseArgs(process.argv.slice(2));

let owner;
let invitee;
let transferTarget;
let workspaceId = '';
let organizationId = '';
let ownerOrganizationMemberId = '';
let acceptedMemberId = '';
let transferMemberId = '';
let transferOrganizationMemberId = '';
let temporaryOrganizationOwnerToken = '';
let originalOrganizationOwnerMemberId = '';
let organizationRemovalPermissionId = '';
let roleProbeOrganizationMemberId = '';
let policyWorkspaceId = '';
let policyWorkspaceOwnerToken = '';
let publicShareEnabled = false;
let lifecyclePageId = '';
let lifecycleBlockId = '';
let offboardingContentPageId = '';
let offboardingContentBlockId = '';
let offboardingContentCommentId = '';
const passwordAccounts = [];

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFAIL workspace membership smoke: ${message}`);
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
    console.error('Start the local EdgeBase runtime first: npm --prefix backend run dev');
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
  console.log(`Workspace membership smoke target: ${baseUrl}`);

  await assertRuntimeReachable(baseUrl);
  const suffix = crypto.randomUUID().slice(0, 8);
  const organizationDomain = `membership-smoke-${suffix}.example.com`;
  const email = `membership-smoke-${suffix}@${organizationDomain}`;
  const transferEmail = `owner-transfer-${suffix}@example.com`;
  owner = await signIn(baseUrl);
  invitee = await signUpWithPassword(
    baseUrl,
    email,
    smokePassword(`invitee-${suffix}`),
    'Membership smoke invitee',
  );
  transferTarget = await signUpWithPassword(
    baseUrl,
    transferEmail,
    smokePassword(`transfer-${suffix}`),
    'Owner transfer smoke target',
  );
  assert(owner.userId !== invitee.userId, 'owner and invitee must be different users');
  assert(
    ![owner.userId, invitee.userId].includes(transferTarget.userId),
    'owner transfer target must be a different user',
  );

  const bootstrap = await callFunction(baseUrl, owner.token, 'workspace-bootstrap', {});
  workspaceId = bootstrap?.workspace?.id;
  assert(workspaceId, 'workspace-bootstrap must return a workspace id');
  assert(bootstrap?.organization?.id, 'workspace-bootstrap must return an organization id');
  assert(
    bootstrap.workspace.organizationId === bootstrap.organization.id,
    'workspace-bootstrap must link the workspace to its organization',
  );
  assert(
    bootstrap?.currentOrganizationMember?.role === 'owner',
    'workspace-bootstrap must make the workspace owner an organization owner',
  );
  ownerOrganizationMemberId = bootstrap.currentOrganizationMember.id;
  assert(
    Array.isArray(bootstrap.organizations) &&
      bootstrap.organizations.some((organization) => organization.id === bootstrap.organization.id),
    'workspace-bootstrap must include the active organization in accessible organizations',
  );
  console.log('PASS bootstrap creates and links the default organization/account.');

  const listedOrganizations = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'listOrganizations',
  });
  assert(
    listedOrganizations?.organizations?.some((organization) => organization.id === bootstrap.organization.id),
    'workspace-mutation listOrganizations must return the default organization',
  );
  console.log('PASS organization/account listing is available through product APIs.');

  lifecyclePageId = crypto.randomUUID();
  lifecycleBlockId = crypto.randomUUID();
  const lifecyclePage = await callFunction(baseUrl, owner.token, 'page-mutation', {
    action: 'create',
    id: lifecyclePageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Membership lifecycle smoke ${lifecyclePageId}`,
    position: Date.now(),
  });
  assert(lifecyclePage?.page?.id === lifecyclePageId, 'owner must be able to create a lifecycle smoke page');
  const lifecycleBlock = await callFunction(baseUrl, owner.token, 'block-mutation', {
    action: 'create',
    id: lifecycleBlockId,
    pageId: lifecyclePageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Membership lifecycle smoke block' }] },
    plainText: 'Membership lifecycle smoke block',
    position: 1,
  });
  assert(lifecycleBlock?.block?.id === lifecycleBlockId, 'owner must be able to create a lifecycle smoke block');

  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'members',
    workspaceId,
  }, 403);
  console.log('PASS non-member users cannot list workspace members before being added.');

  // Server-level model: the owner adds an EXISTING account by email (resolved
  // server-side to the invitee's account). Membership lands immediately — there
  // is no invitation email, token, or recipient accept step.
  const added = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addMember',
    workspaceId,
    email,
    displayName: 'Membership smoke invitee',
    role: 'guest',
  });
  assert(added?.member?.userId === invitee.userId, 'addMember must resolve the email to the invitee membership');
  assert(added.member.role === 'guest', 'addMember must apply the requested role');
  assert(
    Array.isArray(added.members) && added.members.some((item) => item.userId === invitee.userId),
    'addMember response must include the new member',
  );
  acceptedMemberId = added.member.id;
  console.log('PASS owner adds an existing account by email and membership lands immediately.');

  const acceptedBootstrap = await callFunction(baseUrl, invitee.token, 'workspace-bootstrap', {
    workspaceId,
  });
  assert(acceptedBootstrap?.workspace?.id === workspaceId, 'accepted member must bootstrap into the workspace');
  assert(
    acceptedBootstrap?.currentMember?.userId === invitee.userId,
    'accepted member bootstrap must return the invitee membership',
  );
  assert(
    Array.isArray(acceptedBootstrap.members) &&
      acceptedBootstrap.members.length === 1 &&
      acceptedBootstrap.members[0]?.userId === invitee.userId,
    'non-admin bootstrap must redact the workspace member directory to the current member',
  );
  assert(
    Array.isArray(acceptedBootstrap.organizationMembers) &&
      acceptedBootstrap.organizationMembers.length === 0,
    'non-admin bootstrap must not expose the organization member directory',
  );
  assert(
    Array.isArray(acceptedBootstrap.organizationDomains) &&
      acceptedBootstrap.organizationDomains.length === 0,
    'non-admin bootstrap must not expose organization domains',
  );
  console.log('PASS server-level member add creates a real workspace membership usable by bootstrap.');

  organizationId = acceptedBootstrap?.organization?.id ?? '';
  assert(organizationId, 'accepted member bootstrap must return the workspace organization');
  const inviteeMembersView = await callFunction(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'members',
    workspaceId,
  });
  assert(
    Array.isArray(inviteeMembersView.members) &&
      inviteeMembersView.members.length === 1 &&
      inviteeMembersView.members[0]?.userId === invitee.userId,
    'non-admin members API must redact the workspace directory to the current member',
  );
  assert(
    Array.isArray(inviteeMembersView.invitations) &&
      inviteeMembersView.invitations.length === 0,
    'non-admin members API must not expose pending invitations',
  );
  assert(
    !Array.isArray(inviteeMembersView.organizationMembers) ||
      inviteeMembersView.organizationMembers.length === 0,
    'non-admin members API must not expose organization members',
  );
  assert(
    !Array.isArray(inviteeMembersView.organizationDomains) ||
      inviteeMembersView.organizationDomains.length === 0,
    'non-admin members API must not expose organization domains',
  );
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
  }, 403);
  const inviteePeopleSearch = await callFunction(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'searchOrganizationPeople',
    organizationId,
    query: email,
    limit: 5,
    includeInvited: true,
  });
  const inviteeSearchProfile = inviteePeopleSearch?.people?.find((profile) => profile.userId === invitee.userId);
  assert(inviteeSearchProfile?.email === email, 'non-admin people search must still find active collaborators');
  assert(
    Array.isArray(inviteeSearchProfile.workspaceMemberships) &&
      inviteeSearchProfile.workspaceMemberships.length === 0,
    'non-admin people search must not expose workspace membership details',
  );
  assert(
    Array.isArray(inviteeSearchProfile.pendingInvitations) &&
      inviteeSearchProfile.pendingInvitations.length === 0,
    'non-admin people search must not expose pending invitation details',
  );
  console.log('PASS non-admin member and organization directory reads are redacted.');
  const directory = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
  });
  const acceptedOrganizationMember = directory?.organizationMembers?.find(
    (member) => member.userId === invitee.userId,
  );
  assert(acceptedOrganizationMember?.id, 'accepted member must appear in the organization directory');
  const acceptedOrganizationProfile = directory?.organizationProfiles?.find(
    (profile) => profile.userId === invitee.userId,
  );
  assert(
    acceptedOrganizationProfile?.workspaceMemberships?.some(
      (membership) => membership.workspaceId === workspaceId && membership.role === 'guest',
    ),
    'accepted member organization profile must include workspace membership details',
  );
  const peopleSearch = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'searchOrganizationPeople',
    organizationId,
    query: email,
    limit: 5,
  });
  assert(
    peopleSearch?.people?.some(
      (profile) => profile.userId === invitee.userId && profile.email === email,
    ),
    'searchOrganizationPeople must find accepted organization people by email',
  );
  const groupName = `Membership smoke group ${suffix}`;
  const createdGroup = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'createOrganizationGroup',
    organizationId,
    name: groupName,
  });
  const organizationGroup = createdGroup?.organizationGroups?.find((group) => group.name === groupName);
  assert(organizationGroup?.id, 'createOrganizationGroup must add an organization group');
  const updatedGroupName = `${groupName} Updated`;
  const groupUpdated = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationGroup',
    organizationId,
    organizationGroupId: organizationGroup.id,
    name: updatedGroupName,
  });
  assert(
    groupUpdated?.organizationGroups?.some(
      (group) => group.id === organizationGroup.id && group.name === updatedGroupName,
    ),
    'updateOrganizationGroup must rename organization groups',
  );
  const groupMemberAdded = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addOrganizationGroupMember',
    organizationId,
    organizationGroupId: organizationGroup.id,
    organizationMemberId: acceptedOrganizationMember.id,
  });
  assert(
    groupMemberAdded?.organizationGroups?.some(
      (group) =>
        group.id === organizationGroup.id &&
        group.members?.some((member) => member.organizationMemberId === acceptedOrganizationMember.id),
    ),
    'addOrganizationGroupMember must attach active organization members to groups',
  );
  const groupMemberRemoved = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationGroupMember',
    organizationId,
    organizationGroupId: organizationGroup.id,
    organizationMemberId: acceptedOrganizationMember.id,
  });
  assert(
    groupMemberRemoved?.organizationGroups?.some(
      (group) => group.id === organizationGroup.id && group.members?.length === 0,
    ),
    'removeOrganizationGroupMember must remove members from groups',
  );
  const groupDeleted = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'deleteOrganizationGroup',
    organizationId,
    organizationGroupId: organizationGroup.id,
  });
  assert(
    !groupDeleted?.organizationGroups?.some((group) => group.id === organizationGroup.id),
    'deleteOrganizationGroup must remove organization groups',
  );
  assert(
    acceptedOrganizationMember.status === 'active' || !acceptedOrganizationMember.status,
    'accepted organization member must start active',
  );
  const roleProbeEmail = `membership-role-probe-${suffix}@example.com`;
  const roleProbe = await signUpWithPassword(
    baseUrl,
    roleProbeEmail,
    smokePassword(`role-probe-${suffix}`),
    'Membership role probe',
  );
  const roleProbeAdded = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addMember',
    workspaceId,
    email: roleProbeEmail,
    displayName: 'Membership role probe',
    role: 'member',
  });
  assert(
    roleProbeAdded?.member?.userId === roleProbe.userId,
    'role probe must be added as a workspace member',
  );
  const roleProbeDirectory = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
  });
  const roleProbeMember = roleProbeDirectory.organizationMembers?.find(
    (member) => member.userId === roleProbe.userId,
  );
  roleProbeOrganizationMemberId = roleProbeMember?.id ?? '';
  assert(roleProbeOrganizationMemberId, 'role probe must appear in organization directory');

  const securityRole = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationMemberRole',
    organizationId,
    organizationMemberId: roleProbeOrganizationMemberId,
    role: 'security_admin',
  });
  assert(
    securityRole?.organizationMembers?.some(
      (member) => member.id === roleProbeOrganizationMemberId && member.role === 'security_admin',
    ),
    'owner must be able to assign security admin role',
  );
  await callFunction(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'closed',
  });
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'createOrganizationGroup',
    organizationId,
    name: `Security role should not create group ${suffix}`,
  }, 403);
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: 64 * 1024 * 1024,
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'public',
  });

  const billingRole = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationMemberRole',
    organizationId,
    organizationMemberId: roleProbeOrganizationMemberId,
    role: 'billing_admin',
  });
  assert(
    billingRole?.organizationMembers?.some(
      (member) => member.id === roleProbeOrganizationMemberId && member.role === 'billing_admin',
    ),
    'owner must be able to assign billing admin role',
  );
  await callFunction(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: 64 * 1024 * 1024,
  });
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'closed',
  }, 403);
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'addOrganizationDomain',
    organizationId,
    domain: `billing-blocked-${suffix}.example.com`,
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: null,
  });

  const adminRole = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationMemberRole',
    organizationId,
    organizationMemberId: roleProbeOrganizationMemberId,
    role: 'admin',
  });
  assert(
    adminRole?.organizationMembers?.some(
      (member) => member.id === roleProbeOrganizationMemberId && member.role === 'admin',
    ),
    'owner must be able to assign organization admin role',
  );
  const adminGroup = await callFunction(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'createOrganizationGroup',
    organizationId,
    name: `Role probe group ${suffix}`,
  });
  const adminGroupId = adminGroup.organizationGroups?.find(
    (group) => group.name === `Role probe group ${suffix}`,
  )?.id;
  assert(adminGroupId, 'organization admin must be able to create people groups');
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'closed',
  }, 403);
  await expectFunctionStatus(baseUrl, roleProbe.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    storageLimitBytes: 64 * 1024 * 1024,
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'deleteOrganizationGroup',
    organizationId,
    organizationGroupId: adminGroupId,
  });
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationMember',
    organizationId,
    organizationMemberId: roleProbeOrganizationMemberId,
    reassignToOrganizationMemberId: ownerOrganizationMemberId,
  });
  roleProbeOrganizationMemberId = '';
  console.log('PASS organization admin roles split people, security, and billing permissions.');

  const authAudit = await callFunction(baseUrl, owner.token, 'auth-audit', {
    method: 'email_otp',
    phase: 'verify',
    outcome: 'success',
    email,
  });
  assert(authAudit?.recorded >= 1, 'auth-audit must record known organization login attempts');
  const filteredAuthAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'auth.login_attempt',
    auditLimit: 5,
  });
  assert(
    filteredAuthAudit?.organizationAuditEvents?.some(
      (event) =>
        event.action === 'auth.login_attempt' &&
        event.metadata?.email === email &&
        event.metadata?.method === 'email_otp' &&
        event.metadata?.outcome === 'success',
    ),
    'organizationDirectory must expose filterable auth login attempt audit events',
  );
  console.log('PASS accepted workspace members are synced into the organization directory.');

  const originalOrganizationOwnerMember = directory?.organizationMembers?.find(
    (member) => member.userId === owner.userId,
  );
  assert(originalOrganizationOwnerMember?.id, 'organization owner must appear in the organization directory');
  const transferAdded = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addMember',
    workspaceId,
    email: transferEmail,
    displayName: 'Owner transfer smoke target',
    role: 'guest',
  });
  transferMemberId = transferAdded?.member?.id ?? '';
  assert(transferMemberId, 'owner transfer target must be added to the workspace');
  const workspaceOwnerTransferred = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'transferWorkspaceOwner',
    workspaceId,
    memberId: transferMemberId,
  });
  assert(
    workspaceOwnerTransferred?.workspace?.ownerId === transferTarget.userId,
    'transferWorkspaceOwner must move workspace ownership to the target member',
  );
  assert(
    workspaceOwnerTransferred?.members?.some(
      (member) => member.id === transferMemberId && member.role === 'owner',
    ),
    'transferWorkspaceOwner must promote the target workspace member to owner',
  );
  assert(
    workspaceOwnerTransferred?.currentMember?.userId === owner.userId &&
      workspaceOwnerTransferred.currentMember.role === 'admin',
    'transferWorkspaceOwner must keep the previous owner as workspace admin',
  );
  const workspaceOwnerRestored = await callFunction(baseUrl, transferTarget.token, 'workspace-mutation', {
    action: 'transferWorkspaceOwner',
    workspaceId,
    userId: owner.userId,
  });
  assert(
    workspaceOwnerRestored?.workspace?.ownerId === owner.userId,
    'transferWorkspaceOwner must allow the new owner to transfer ownership back',
  );
  assert(
    workspaceOwnerRestored?.members?.some(
      (member) => member.userId === owner.userId && member.role === 'owner',
    ),
    'restored workspace owner must regain the owner role',
  );
  console.log('PASS workspace ownership can be transferred to an active member and restored.');
  const transferDirectory = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
  });
  const transferOrganizationMember = transferDirectory?.organizationMembers?.find(
    (member) => member.userId === transferTarget.userId,
  );
  transferOrganizationMemberId = transferOrganizationMember?.id ?? '';
  assert(transferOrganizationMemberId, 'owner transfer target must sync into the organization directory');
  temporaryOrganizationOwnerToken = transferTarget.token;
  originalOrganizationOwnerMemberId = originalOrganizationOwnerMember.id;
  const transferredOwner = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'transferOrganizationOwner',
    organizationId,
    organizationMemberId: transferOrganizationMemberId,
  });
  assert(
    transferredOwner?.organization?.ownerId === transferTarget.userId,
    'transferOrganizationOwner must move organization ownership to the target member',
  );
  assert(
    transferredOwner?.organizationMembers?.some(
      (member) => member.id === transferOrganizationMemberId && member.role === 'owner',
    ),
    'transferOrganizationOwner must promote the target organization member to owner',
  );
  const restoredOwner = await callFunction(baseUrl, transferTarget.token, 'workspace-mutation', {
    action: 'transferOrganizationOwner',
    organizationId,
    organizationMemberId: originalOrganizationOwnerMemberId,
  });
  assert(
    restoredOwner?.organization?.ownerId === owner.userId,
    'transferOrganizationOwner must allow the new owner to transfer ownership back',
  );
  assert(
    restoredOwner?.organizationMembers?.some(
      (member) => member.id === originalOrganizationOwnerMemberId && member.role === 'owner',
    ),
    'restored organization owner must regain the owner role',
  );
  temporaryOrganizationOwnerToken = '';
  offboardingContentPageId = crypto.randomUUID();
  offboardingContentBlockId = crypto.randomUUID();
  offboardingContentCommentId = crypto.randomUUID();
  const offboardingPage = await callFunction(baseUrl, transferTarget.token, 'page-mutation', {
    action: 'create',
    id: offboardingContentPageId,
    workspaceId,
    parentId: null,
    parentType: 'workspace',
    kind: 'page',
    title: `Organization offboarding reassignment ${offboardingContentPageId}`,
    position: Date.now() + 1,
  });
  assert(
    offboardingPage?.page?.createdBy === transferTarget.userId &&
      offboardingPage.page.lastEditedBy === transferTarget.userId,
    'offboarding smoke target must create a page before removal',
  );
  const offboardingBlock = await callFunction(baseUrl, transferTarget.token, 'block-mutation', {
    action: 'create',
    id: offboardingContentBlockId,
    pageId: offboardingContentPageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Organization offboarding reassignment block' }] },
    plainText: 'Organization offboarding reassignment block',
    position: 1,
  });
  assert(
    offboardingBlock?.block?.createdBy === transferTarget.userId,
    'offboarding smoke target must create a block before removal',
  );
  const offboardingComment = await callFunction(baseUrl, transferTarget.token, 'comment-mutation', {
    action: 'create',
    id: offboardingContentCommentId,
    pageId: offboardingContentPageId,
    blockId: offboardingContentBlockId,
    body: { rich: [{ text: 'Organization offboarding reassignment comment' }] },
  });
  assert(
    offboardingComment?.comment?.authorId === transferTarget.userId,
    'offboarding smoke target must create a comment before removal',
  );
  const directPermission = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId: lifecyclePageId,
    principalType: 'user',
    principalId: transferTarget.userId,
    label: 'Organization removal smoke target',
    role: 'view',
  });
  organizationRemovalPermissionId = directPermission?.permission?.id ?? '';
  assert(organizationRemovalPermissionId, 'organization removal smoke must create a direct page permission');
  const removedOrganizationMember = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationMember',
    organizationId,
    organizationMemberId: transferOrganizationMemberId,
    reassignToOrganizationMemberId: originalOrganizationOwnerMemberId,
  });
  assert(
    !removedOrganizationMember?.organizationMembers?.some((member) => member.id === transferOrganizationMemberId),
    'removeOrganizationMember must remove the member from the organization directory',
  );
  const organizationRemovalAudit = removedOrganizationMember?.organizationAuditEvents?.find(
    (event) => event.action === 'organization_member.remove' && event.targetId === transferOrganizationMemberId,
  );
  assert(
    organizationRemovalAudit?.metadata?.contentReassignedToOrganizationMemberId === originalOrganizationOwnerMemberId,
    'removeOrganizationMember must record the content reassignment target in audit metadata',
  );
  assert(
    organizationRemovalAudit?.metadata?.contentReassignment?.pagesCreatedBy >= 1 &&
      organizationRemovalAudit.metadata.contentReassignment.pagesLastEditedBy >= 1 &&
      organizationRemovalAudit.metadata.contentReassignment.blocksCreatedBy >= 1 &&
      organizationRemovalAudit.metadata.contentReassignment.commentsAuthorId >= 1,
    'removeOrganizationMember must audit reassigned pages, blocks, and comments',
  );
  const reassignedPage = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'page',
    pageId: offboardingContentPageId,
  });
  assert(
    reassignedPage?.page?.createdBy === owner.userId &&
      reassignedPage.page.lastEditedBy === owner.userId,
    'removeOrganizationMember must reassign removed-member page ownership metadata',
  );
  const reassignedBlocks = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'blocks',
    pageId: offboardingContentPageId,
  });
  assert(
    reassignedBlocks?.blocks?.some(
      (block) => block.id === offboardingContentBlockId && block.createdBy === owner.userId,
    ),
    'removeOrganizationMember must reassign removed-member block ownership metadata',
  );
  const reassignedComments = await callFunction(baseUrl, owner.token, 'page-query', {
    action: 'comments',
    pageId: offboardingContentPageId,
  });
  assert(
    reassignedComments?.comments?.some(
      (comment) => comment.id === offboardingContentCommentId && comment.authorId === owner.userId,
    ),
    'removeOrganizationMember must reassign removed-member comment authorship metadata',
  );
  assert(
    removedOrganizationMember?.organizationAuditEvents?.some(
      (event) => event.action === 'organization_member.remove',
    ),
    'removeOrganizationMember must record an organization audit event',
  );
  const filteredRemovalAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'organization_member.remove',
    auditLimit: 5,
  });
  assert(
    filteredRemovalAudit?.organizationAuditEvents?.length >= 1 &&
      filteredRemovalAudit.organizationAuditEvents.every((event) => event.action === 'organization_member.remove'),
    'organizationDirectory must filter organization audit events by action',
  );
  await expectFunctionStatus(baseUrl, transferTarget.token, 'workspace-bootstrap', {
    workspaceId,
  }, 403);
  await expectFunctionStatus(baseUrl, transferTarget.token, 'page-query', {
    action: 'page',
    pageId: lifecyclePageId,
  }, 403);
  await permanentlyDeletePage(baseUrl, owner.token, offboardingContentPageId, { call: callFunction });
  offboardingContentPageId = '';
  offboardingContentBlockId = '';
  offboardingContentCommentId = '';
  transferMemberId = '';
  transferOrganizationMemberId = '';
  organizationRemovalPermissionId = '';
  originalOrganizationOwnerMemberId = '';
  console.log('PASS organization ownership transfer restores cleanly and organization member removal reassigns content and revokes access.');

  const addedDomain = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'addOrganizationDomain',
    organizationId,
    domain: organizationDomain,
  });
  const pendingDomain = addedDomain?.organizationDomains?.find((domain) => domain.domain === organizationDomain);
  assert(pendingDomain?.id, 'addOrganizationDomain must add a pending organization domain');
  assert(pendingDomain.status === 'pending' || !pendingDomain.status, 'new organization domain must start pending');
  const verifiedDomain = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'verifyOrganizationDomain',
    organizationId,
    organizationDomainId: pendingDomain.id,
  });
  assert(
    verifiedDomain?.organizationDomains?.some(
      (domain) => domain.id === pendingDomain.id && domain.status === 'verified',
    ),
    'verifyOrganizationDomain must mark the organization domain verified',
  );
  const domainRestrictedSignup = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    domainSignupPolicy: 'verified_domains',
  });
  assert(
    domainRestrictedSignup?.organization?.domainSignupPolicy === 'verified_domains',
    'updateOrganizationSettings must enable verified-domain signup policy',
  );
  // Global signup policy now has two modes: 'closed' disables self-service
  // signup entirely (accounts are provisioned by an instance admin), and
  // 'public' re-opens it. The workspace-invitation signup gate is gone.
  const closedSignupPolicy = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'closed',
  });
  assert(
    closedSignupPolicy?.instanceSettings?.signupPolicy === 'closed',
    'updateOrganizationSettings must enable the closed global signup policy',
  );
  const blockedSignupEmail = `blocked-signup-${suffix}@external.example`;
  const blockedSignupPassword = smokePassword(suffix);
  await expectAuthSignupStatus(
    baseUrl,
    blockedSignupEmail,
    blockedSignupPassword,
    'Blocked Signup Smoke',
    403,
  );
  await expectAuthPasswordSigninStatus(baseUrl, blockedSignupEmail, blockedSignupPassword, 401);

  const publicSignupPolicy = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    signupPolicy: 'public',
  });
  assert(
    publicSignupPolicy?.instanceSettings?.signupPolicy === 'public',
    'updateOrganizationSettings must restore public global signup policy',
  );
  const openSignup = await signUpWithPassword(
    baseUrl,
    `open-signup-${suffix}@external.example`,
    smokePassword(`${suffix}Open`),
    'Open Signup Smoke',
  );
  assert(openSignup?.token, 'public signup policy must allow self-service account creation');
  console.log('PASS global signup policy blocks self-service signup when closed and allows it when public.');

  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { publicWebSharing: false },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: lifecyclePageId,
    enabled: true,
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { publicWebSharing: true },
  });
  const publicShare = await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: lifecyclePageId,
    enabled: true,
  });
  publicShareEnabled = true;
  const publicToken = publicShare?.shareLink?.token;
  assert(publicToken, 'enabled public web sharing must return a share token');
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { publicWebSharing: false },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'publicPage',
    token: publicToken,
  }, 404);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { publicWebSharing: true },
  });
  await callFunction(baseUrl, owner.token, 'share-mutation', {
    action: 'setWebSharing',
    pageId: lifecyclePageId,
    enabled: false,
  });
  publicShareEnabled = false;

  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { externalEmailSharing: false },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId: lifecyclePageId,
    principalType: 'email',
    label: `page-policy-${suffix}@external.example`,
    role: 'view',
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { externalEmailSharing: true },
  });

  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { guestAccess: false },
  });
  // Page-level email sharing still enforces the org guest-access policy. (A
  // workspace member-add for an external email with no server account is a
  // blind no-op rather than a policy rejection, so it is not asserted here.)
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId: lifecyclePageId,
    principalType: 'email',
    label: `page-guest-policy-${suffix}@external.example`,
    role: 'view',
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { guestAccess: true },
  });

  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { fullAccessGrants: false },
  });
  await expectFunctionStatus(baseUrl, owner.token, 'share-mutation', {
    action: 'invite',
    pageId: lifecyclePageId,
    principalType: 'user',
    principalId: invitee.userId,
    label: 'Membership smoke full access policy',
    role: 'full_access',
  }, 403);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    sharingPolicy: { fullAccessGrants: true },
  });
  console.log('PASS organization sharing policy gates public web, external email, guest access, and full-access grants.');

  const guestProfile = await callFunction(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'updateMyProfile',
    workspaceId,
    displayName: 'Membership smoke invitee',
    email: `accepted-member-${suffix}@${organizationDomain}`,
  });
  assert(
    guestProfile?.member?.email === `accepted-member-${suffix}@${organizationDomain}`,
    'guest profile must be able to move onto a verified organization domain before member promotion',
  );
  const promotedMember = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateMemberRole',
    workspaceId,
    memberId: acceptedMemberId,
    role: 'member',
  });
  assert(promotedMember?.member?.role === 'member', 'owner must be able to promote verified-domain invitee to member');
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'updateMyProfile',
    workspaceId,
    displayName: 'Membership smoke invitee',
    email: `accepted-member-${suffix}@external.example`,
  }, 400);
  const internalProfile = await callFunction(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'updateMyProfile',
    workspaceId,
    displayName: 'Membership smoke invitee',
    email: `accepted-member-updated-${suffix}@${organizationDomain}`,
  });
  assert(
    internalProfile?.member?.email === `accepted-member-updated-${suffix}@${organizationDomain}`,
    'domain-restricted organization members must keep verified-domain profile emails',
  );
  const roleUpdateAudit = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'organizationDirectory',
    organizationId,
    auditAction: 'workspace_member.role_update',
    auditLimit: 5,
  });
  assert(
    roleUpdateAudit?.organizationAuditEvents?.some(
      (event) => event.targetId === acceptedMemberId,
    ),
    'workspace member role changes must record a filterable organization audit event',
  );
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'createWorkspace',
    organizationId,
    name: `Blocked member workspace ${suffix}`,
  }, 403);
  const memberPolicy = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    workspaceCreationPolicy: 'members',
  });
  assert(
    memberPolicy?.organization?.workspaceCreationPolicy === 'members',
    'organization owners must be able to allow member workspace creation',
  );
  const memberWorkspace = await callFunction(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'createWorkspace',
    organizationId,
    name: `Member-created workspace ${suffix}`,
    domain: `member-created-${suffix}`,
  });
  policyWorkspaceId = memberWorkspace?.workspace?.id ?? '';
  policyWorkspaceOwnerToken = invitee.token;
  assert(policyWorkspaceId, 'member workspace creation policy must allow organization members to create workspaces');
  await deleteWorkspaceThroughProductApi(baseUrl, policyWorkspaceOwnerToken, policyWorkspaceId);
  policyWorkspaceId = '';
  policyWorkspaceOwnerToken = '';
  const ownerAdminPolicy = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    workspaceCreationPolicy: 'owners_admins',
  });
  assert(
    ownerAdminPolicy?.organization?.workspaceCreationPolicy === 'owners_admins',
    'organization owners must be able to restrict workspace creation to owners/admins',
  );
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'createWorkspace',
    organizationId,
    name: `Blocked member workspace after policy ${suffix}`,
  }, 403);
  console.log('PASS organization workspace creation policy is enforced for members.');

  await expectFunctionStatus(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationDomain',
    organizationId,
    organizationDomainId: pendingDomain.id,
  }, 400);
  await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateOrganizationSettings',
    organizationId,
    domainSignupPolicy: 'invite_only',
  });
  const removedDomain = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'removeOrganizationDomain',
    organizationId,
    organizationDomainId: pendingDomain.id,
  });
  assert(
    !removedDomain?.organizationDomains?.some((domain) => domain.id === pendingDomain.id),
    'removeOrganizationDomain must remove the organization domain',
  );
  console.log('PASS organization domains can be added, verified, and removed through product APIs.');

  const readableBeforeDeactivation = await callFunction(baseUrl, invitee.token, 'page-query', {
    action: 'page',
    pageId: lifecyclePageId,
  });
  assert(
    readableBeforeDeactivation?.page?.id === lifecyclePageId,
    'active organization member must be able to read workspace pages',
  );
  const memberBlock = await callFunction(baseUrl, invitee.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: lifecyclePageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Member lifecycle write before deactivation' }] },
    plainText: 'Member lifecycle write before deactivation',
    position: 2,
  });
  assert(memberBlock?.block?.id, 'active member must be able to write before deactivation');
  console.log('PASS active organization members can still use page and block product APIs.');

  const deactivated = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'deactivateOrganizationMember',
    organizationId,
    organizationMemberId: acceptedOrganizationMember.id,
  });
  assert(
    deactivated?.organizationMembers?.some(
      (member) => member.id === acceptedOrganizationMember.id && member.status === 'deactivated',
    ),
    'deactivateOrganizationMember must mark the organization member deactivated',
  );
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-bootstrap', {
    workspaceId,
  }, 403);
  await expectFunctionStatus(baseUrl, invitee.token, 'page-query', {
    action: 'page',
    pageId: lifecyclePageId,
  }, 403);
  await expectFunctionStatus(baseUrl, invitee.token, 'page-mutation', {
    action: 'update',
    id: lifecyclePageId,
    patch: { title: 'Blocked after deactivation' },
  }, 403);
  await expectFunctionStatus(baseUrl, invitee.token, 'block-mutation', {
    action: 'create',
    id: crypto.randomUUID(),
    pageId: lifecyclePageId,
    parentId: null,
    type: 'paragraph',
    content: { rich: [{ text: 'Blocked after deactivation' }] },
    plainText: 'Blocked after deactivation',
    position: 3,
  }, 403);
  console.log('PASS deactivated organization members cannot bootstrap or use page/block product APIs.');

  const reactivated = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'reactivateOrganizationMember',
    organizationId,
    organizationMemberId: acceptedOrganizationMember.id,
  });
  assert(
    reactivated?.organizationMembers?.some(
      (member) => member.id === acceptedOrganizationMember.id && (member.status === 'active' || !member.status),
    ),
    'reactivateOrganizationMember must mark the organization member active',
  );
  const reactivatedBootstrap = await callFunction(baseUrl, invitee.token, 'workspace-bootstrap', {
    workspaceId,
  });
  assert(
    reactivatedBootstrap?.currentMember?.userId === invitee.userId,
    'reactivated organization member must regain workspace bootstrap access',
  );
  console.log('PASS reactivated organization members regain workspace bootstrap access.');

  const demoted = await callFunction(baseUrl, owner.token, 'workspace-mutation', {
    action: 'updateMemberRole',
    workspaceId,
    memberId: acceptedMemberId,
    role: 'guest',
  });
  assert(demoted?.member?.role === 'guest', 'owner must be able to demote invitee back to guest');

  // A guest workspace member cannot add other members: the admin-permission
  // check runs before any account resolution, so this is denied regardless of
  // whether the target email has an account.
  await expectFunctionStatus(baseUrl, invitee.token, 'workspace-mutation', {
    action: 'addMember',
    workspaceId,
    email: `guest-created-${suffix}@example.com`,
    role: 'member',
  }, 403);
  console.log('PASS guest workspace members cannot add more members.');

  console.log('\nPASS server-level workspace membership add and guest add denial work through product APIs.');
}

async function cleanupResources() {
  if (!owner?.token || !workspaceId) return;
  const baseUrl = normalizeBaseUrl(options.url);
  if (temporaryOrganizationOwnerToken && originalOrganizationOwnerMemberId && organizationId) {
    await callFunction(baseUrl, temporaryOrganizationOwnerToken, 'workspace-mutation', {
      action: 'transferOrganizationOwner',
      organizationId,
      organizationMemberId: originalOrganizationOwnerMemberId,
    }).catch(() => {});
    temporaryOrganizationOwnerToken = '';
    originalOrganizationOwnerMemberId = '';
  }
  if (policyWorkspaceId && policyWorkspaceOwnerToken) {
    await deleteWorkspaceThroughProductApi(baseUrl, policyWorkspaceOwnerToken, policyWorkspaceId).catch(() => {});
    policyWorkspaceId = '';
    policyWorkspaceOwnerToken = '';
  }
  if (organizationId) {
    if (publicShareEnabled && lifecyclePageId) {
      await callFunction(baseUrl, owner.token, 'share-mutation', {
        action: 'setWebSharing',
        pageId: lifecyclePageId,
        enabled: false,
      }).catch(() => {});
      publicShareEnabled = false;
    }
    if (roleProbeOrganizationMemberId) {
      await callFunction(baseUrl, owner.token, 'workspace-mutation', {
        action: 'removeOrganizationMember',
        organizationId,
        organizationMemberId: roleProbeOrganizationMemberId,
        ...(ownerOrganizationMemberId ? { reassignToOrganizationMemberId: ownerOrganizationMemberId } : {}),
      }).catch(() => {});
      roleProbeOrganizationMemberId = '';
    }
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'updateOrganizationSettings',
      organizationId,
      workspaceCreationPolicy: 'owners_admins',
      signupPolicy: 'public',
      domainSignupPolicy: 'invite_only',
      sharingPolicy: {
        publicWebSharing: true,
        externalEmailSharing: true,
        guestAccess: true,
        fileDownloads: true,
        fullAccessGrants: true,
      },
    }).catch(() => {});
    if (transferOrganizationMemberId) {
      await callFunction(baseUrl, owner.token, 'workspace-mutation', {
        action: 'deactivateOrganizationMember',
        organizationId,
        organizationMemberId: transferOrganizationMemberId,
      }).catch(() => {});
      transferOrganizationMemberId = '';
    }
  }
  if (organizationRemovalPermissionId) {
    await callFunction(baseUrl, owner.token, 'share-mutation', {
      action: 'removePermission',
      permissionId: organizationRemovalPermissionId,
    }).catch(() => {});
    organizationRemovalPermissionId = '';
  }
  if (offboardingContentPageId) {
    await permanentlyDeletePage(baseUrl, owner.token, offboardingContentPageId, { call: callFunction }).catch(() => {});
    offboardingContentPageId = '';
    offboardingContentBlockId = '';
    offboardingContentCommentId = '';
  }
  if (transferMemberId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'removeMember',
      workspaceId,
      memberId: transferMemberId,
    }).catch(() => {});
    transferMemberId = '';
  }
  if (acceptedMemberId) {
    await callFunction(baseUrl, owner.token, 'workspace-mutation', {
      action: 'removeMember',
      workspaceId,
      memberId: acceptedMemberId,
    }).catch(() => {});
    acceptedMemberId = '';
  }
  if (lifecyclePageId) {
    await permanentlyDeletePage(baseUrl, owner.token, lifecyclePageId, { call: callFunction }).catch(() => {});
    lifecyclePageId = '';
    lifecycleBlockId = '';
  }
}

async function cleanup() {
  const failures = [];
  await cleanupResources().catch((error) => failures.push(error));
  await cleanupPasswordAccounts().catch((error) => failures.push(error));
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Workspace membership smoke cleanup was incomplete.');
  }
}

async function cleanupPasswordAccounts() {
  if (passwordAccounts.length === 0) return;
  const baseUrl = normalizeBaseUrl(options.url);
  const adminToken = await signInMaster(baseUrl);
  await deleteSmokeAccounts(baseUrl, adminToken, passwordAccounts, { call: callFunction });
}

async function deleteWorkspaceThroughProductApi(baseUrl, token, targetWorkspaceId) {
  await deleteWorkspacePages(baseUrl, token, targetWorkspaceId);
  await callFunction(baseUrl, token, 'workspace-mutation', {
    action: 'deleteWorkspace',
    workspaceId: targetWorkspaceId,
  });
}

async function deleteWorkspacePages(baseUrl, token, targetWorkspaceId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const listed = await callFunction(baseUrl, token, 'page-query', {
      action: 'pages',
      workspaceId: targetWorkspaceId,
      includeTrash: true,
    });
    const pages = Array.isArray(listed?.pages) ? listed.pages : [];
    const rootPages = pages.filter((page) =>
      page?.workspaceId === targetWorkspaceId &&
      (page.parentType === 'workspace' || page.parentId == null)
    );
    if (rootPages.length === 0) return;

    for (const page of rootPages) {
      if (!page?.id) continue;
      await permanentlyDeletePage(baseUrl, token, page.id, { call: callFunction });
    }
  }

  const remaining = await callFunction(baseUrl, token, 'page-query', {
    action: 'pages',
    workspaceId: targetWorkspaceId,
    includeTrash: true,
  });
  throw new Error(
    `workspace ${targetWorkspaceId} still has pages before deleteWorkspace: ${JSON.stringify(remaining?.pages ?? [])}`,
  );
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
  console.log(`Usage: node scripts/workspace-membership-smoke.mjs [options]

Checks workspace email invitation acceptance, accepted/revoked invitation
denial, and guest invite permissions against a running Hanji EdgeBase
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

function smokePassword(seed) {
  const suffix = String(seed ?? crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20);
  return `Aa1!${suffix}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function signUpWithPassword(baseUrl, email, password, displayName) {
  const response = await postAuthPassword(baseUrl, '/api/auth/signup', {
    email,
    password,
    data: { displayName },
  });
  const json = await readJson(response);
  assert(response.status === 201, `/api/auth/signup returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  assert(typeof json?.accessToken === 'string' && json.accessToken, 'password signup must return an access token');
  assert(typeof json?.user?.id === 'string' && json.user.id, 'password signup must return a user id');
  const account = { token: json.accessToken, userId: json.user.id, email, response: json };
  passwordAccounts.push(account);
  return account;
}

async function signInMaster(baseUrl) {
  const credentials = masterCredentials();
  const response = await postAuthPassword(baseUrl, '/api/auth/signin', credentials);
  const json = await readJson(response);
  assert(response.ok, `master sign-in returned HTTP ${response.status}: ${JSON.stringify(json)}`);
  assert(typeof json?.accessToken === 'string' && json.accessToken, 'master sign-in must return an access token');
  return json.accessToken;
}

async function expectAuthSignupStatus(baseUrl, email, password, displayName, status) {
  const response = await postAuthPassword(baseUrl, '/api/auth/signup', {
    email,
    password,
    data: { displayName },
  });
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `/api/auth/signup expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function expectAuthPasswordSigninStatus(baseUrl, email, password, status) {
  const response = await postAuthPassword(baseUrl, '/api/auth/signin', { email, password });
  const json = await readJson(response);
  if (response.status !== status) {
    throw new Error(
      `/api/auth/signin expected HTTP ${status}, got ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function postAuthPassword(baseUrl, path, body) {
  return fetchWithTimeout(resolveUrl(baseUrl, path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callFunction(baseUrl, token, name, body) {
  const response = await postFunction(baseUrl, token, name, body);
  const json = await readJson(response);
  if (!response.ok) {
    throw new Error(`${name} returned HTTP ${response.status}: ${JSON.stringify(json)}`);
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
