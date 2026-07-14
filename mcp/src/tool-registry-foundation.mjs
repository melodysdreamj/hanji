export function registerFoundationTools(runtime) {
  const {
    DATABASE_VIEW_TYPES,
    JsonObjectSchema,
    JsonValueSchema,
    MCP_ACCESS_POLICY_OUTPUT_SCHEMA,
    MCP_LIST_WORKSPACES_OUTPUT_SCHEMA,
    NOTION_FETCH_TOOL,
    NOTION_GET_USERS_TOOL,
    NOTION_IMPORT_CONNECTION_KINDS,
    NOTION_SEARCH_TOOL,
    PAGE_PARENT_TYPES,
    WORKSPACE_MEMBER_ROLES,
    accountAccessibleWorkspaces,
    blockPreview,
    createDatabasePropertyInputSchema,
    databaseViewLabel,
    eb,
    fail,
    handleNotionFetch,
    handleNotionGetUsers,
    handleNotionSearch,
    looksLikeImageIcon,
    normalizeParentInput,
    notionDataSourceFetchPayload,
    notionImportConnectionSummary,
    notionImportItemPreview,
    notionImportJobSummary,
    notionImportPlanSummary,
    ok,
    okJson,
    okStructured,
    organizationLines,
    organizationMemberLines,
    organizationPeopleSearchLines,
    parseNotionCreateTableSchema,
    registerToolAliases,
    requireMatchingWorkspace,
    requireWorkspaceSelection,
    schemaLine,
    server,
    stripHanjiId,
    titleOf,
    workspaceLines,
    workspaceMemberLines,
    workspaceStructuredContent,
    z,
  } = runtime;

  server.registerTool(
    "get_workspace",
    {
      title: "Get workspace",
      description:
        "Get the account workspace selection context. Hanji MCP is account-scoped, so call this first and pass one returned workspace id as workspace_id to workspace-bound tools.",
      inputSchema: {},
    },
    async () => {
      try {
        const ws = await eb.workspace();
        const pages = await eb.pages();
        const workspaces = await accountAccessibleWorkspaces();
        const icon = String(ws.icon ?? "").trim();
        const iconPrefix = icon && !looksLikeImageIcon(icon) ? `${icon} ` : "";
        const iconLine = icon
          ? `\nicon: ${looksLikeImageIcon(icon) ? `image ${icon}` : icon}`
          : "\nicon: none";
        const selectionLines = workspaceLines({ workspaces });
        return ok(
          [
            "Hanji MCP is account-scoped. Choose one workspace below and pass its id as workspace_id.",
            "",
            `Current fallback workspace: ${iconPrefix}${ws.name}`,
            `current fallback id: ${ws.id}${iconLine}`,
            `current fallback pages: ${pages.length}`,
            "",
            ...selectionLines,
          ].join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_mcp_access_policy",
    {
      title: "Get MCP access policy",
      description:
        "Show the local MCP client narrowing policy. Hanji MCP authenticates at account scope; product permissions still come from the authenticated EdgeBase user or service principal, and this policy can narrow that access.",
      inputSchema: {},
      outputSchema: MCP_ACCESS_POLICY_OUTPUT_SCHEMA,
    },
    async () => {
      try {
        const policy = eb.mcpAccessPolicy();
        const list = (items) => (items.length ? items.join(", ") : "(none)");
        return okStructured(
          [
            `readOnly: ${policy.readOnly ? "true" : "false"}`,
            `policyFile: ${policy.policyFile || "(none)"}`,
            `clientId: ${policy.clientId || "(default)"}`,
            `clientName: ${policy.clientName || "(default)"}`,
            `subjectType: ${policy.subjectType || "(none)"}`,
            `subjectId: ${policy.subjectId || "(none)"}`,
            `issuer: ${policy.issuer || "(none)"}`,
            `audience: ${policy.audience || "(none)"}`,
            `transport: ${policy.transport || "(none)"}`,
            `provisioningId: ${policy.provisioningId || "(none)"}`,
            `notBefore: ${policy.notBefore || "(none)"}`,
            `expiresAt: ${policy.expiresAt || "(none)"}`,
            `allowedWorkspaceIds: ${list(policy.allowedWorkspaceIds)}`,
            `allowedPageIds: ${list(policy.allowedPageIds)}`,
            `allowedDatabaseIds: ${list(policy.allowedDatabaseIds)}`,
            `scopes: ${list(policy.scopes)}`,
          ].join("\n"),
          {
            ...policy,
            scopeModel: "hanji_account_accessible_workspaces",
            notionCompatibilityNote:
              "Unlike a Notion MCP connection scoped to one workspace, Hanji authenticates at account scope. Workspace-bound tools require workspace_id, with Notion-compatible teamspace_id accepted as an alias.",
          }
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["search", "_search"], NOTION_SEARCH_TOOL, handleNotionSearch);

  registerToolAliases(["fetch", "_fetch"], NOTION_FETCH_TOOL, handleNotionFetch);

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List all Hanji workspaces accessible to the current account-scoped MCP user. Use a returned workspace id as Notion-compatible teamspace_id to narrow Notion-style tools.",
      inputSchema: {},
      outputSchema: MCP_LIST_WORKSPACES_OUTPUT_SCHEMA,
    },
    async () => {
      try {
        const result = { workspaces: await accountAccessibleWorkspaces() };
        return okStructured(workspaceLines(result).join("\n"), workspaceStructuredContent(result));
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["get_users", "_notion_get_users"], NOTION_GET_USERS_TOOL, handleNotionGetUsers);

  server.registerTool(
    "_notion_get_teams",
    {
      title: "Get teams",
      description:
        "Notion-compatible teamspace listing. Hanji does not have separate Notion teamspaces, so this returns account-accessible workspaces as teamspace-compatible objects.",
      inputSchema: {
        query: z.string().optional(),
      },
    },
    async ({ query }) => {
      try {
        const workspaces = await accountAccessibleWorkspaces();
        const needle = String(query ?? "").trim().toLowerCase();
        const teams = workspaces
          .filter((workspace) => !needle || String(workspace.name ?? "").toLowerCase().includes(needle))
          .slice(0, 10)
          .map((workspace) => ({
            id: workspace.id,
            teamspace_id: workspace.id,
            workspace_id: workspace.id,
            name: workspace.name || workspace.domain || "Workspace",
            type: "workspace_as_teamspace",
            scope_model: "hanji_account_workspace",
            membership_status: "member",
            role: workspace.role ?? workspace.membershipRole ?? "member",
          }));
        return okJson({
          results: teams,
          joined: teams,
          available: [],
          has_more: false,
          provider_scope_model: "hanji_account_accessible_workspaces",
          teamspace_id_alias: "Hanji workspace_id",
          note:
            "Hanji maps Notion teamspaces to accessible workspaces. Choose one of these ids and pass it as workspace_id or teamspace_id; workspace-bound compatible tools reject calls that omit a workspace id.",
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "_notion_query_meeting_notes",
    {
      title: "Query meeting notes",
      description:
        "Notion-compatible meeting notes query stub. Hanji MCP is account-scoped, so workspace_id is required, but Hanji does not provide a separate AI meeting-notes data source.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
        teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
        filter: JsonValueSchema.optional(),
      },
    },
    async ({ workspace_id, teamspace_id }) => {
      try {
        const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_query_meeting_notes");
        if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
        return okJson({
          results: [],
          has_more: false,
          next_cursor: null,
          is_unsupported: true,
          unsupported_feature: "notion_ai_meeting_notes",
          workspace_id: requiredWorkspace.workspaceId,
          message:
            "Hanji does not provide a separate Notion AI meeting-notes data source. Use normal page/database search or a Hanji database dedicated to meetings.",
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_organizations",
    {
      title: "List organizations",
      description:
        "List organizations/accounts accessible to the current MCP user through the backend workspace API.",
      inputSchema: {},
    },
    async () => {
      try {
        const result = await eb.listOrganizations();
        return ok(organizationLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_organization_directory",
    {
      title: "Get organization directory",
      description:
        "List organization/account members and workspaces through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        auditAction: z.string().optional().describe("Optional exact organization audit event action filter"),
        auditTargetType: z.string().optional().describe("Optional exact organization audit target type filter"),
        auditLimit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ organizationId, auditAction, auditTargetType, auditLimit }) => {
      try {
        const result = await eb.organizationDirectory({
          organizationId,
          auditAction,
          auditTargetType,
          auditLimit,
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_organization_people",
    {
      title: "Search organization people",
      description:
        "Search organization people profiles through the backend product API for mentions, sharing, and admin workflows.",
      inputSchema: {
        organizationId: z.string(),
        query: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeInvited: z.boolean().optional(),
        includeDeactivated: z.boolean().optional(),
      },
    },
    async ({ organizationId, query, limit, includeInvited, includeDeactivated }) => {
      try {
        const result = await eb.searchOrganizationPeople({
          organizationId,
          query,
          limit,
          includeInvited,
          includeDeactivated,
        });
        return ok(organizationPeopleSearchLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_organization_settings",
    {
      title: "Update organization settings",
      description:
        "Update organization/account policy settings through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        workspaceCreationPolicy: z
          .enum(["owners_admins", "members"])
          .optional()
          .describe("Who can create workspaces in this organization"),
        domainSignupPolicy: z
          .enum(["invite_only", "verified_domains"])
          .optional()
          .describe("Whether organization members must use verified organization email domains"),
        publicWebSharing: z.boolean().optional(),
        externalEmailSharing: z.boolean().optional(),
        guestAccess: z.boolean().optional(),
        fileDownloads: z.boolean().optional(),
        fullAccessGrants: z.boolean().optional(),
        storageLimitBytes: z
          .number()
          .int()
          .nonnegative()
          .nullable()
          .optional()
          .describe("Organization storage limit in bytes. Pass null to remove the limit."),
      },
    },
    async ({
      organizationId,
      workspaceCreationPolicy,
      domainSignupPolicy,
      publicWebSharing,
      externalEmailSharing,
      guestAccess,
      fileDownloads,
      fullAccessGrants,
      storageLimitBytes,
    }) => {
      try {
        const sharingPolicy = {};
        if (publicWebSharing !== undefined) sharingPolicy.publicWebSharing = publicWebSharing;
        if (externalEmailSharing !== undefined) sharingPolicy.externalEmailSharing = externalEmailSharing;
        if (guestAccess !== undefined) sharingPolicy.guestAccess = guestAccess;
        if (fileDownloads !== undefined) sharingPolicy.fileDownloads = fileDownloads;
        if (fullAccessGrants !== undefined) sharingPolicy.fullAccessGrants = fullAccessGrants;
        const result = await eb.updateOrganizationSettings({
          organizationId,
          workspaceCreationPolicy,
          domainSignupPolicy,
          ...(storageLimitBytes !== undefined ? { storageLimitBytes } : {}),
          ...(Object.keys(sharingPolicy).length ? { sharingPolicy } : {}),
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "transfer_organization_owner",
    {
      title: "Transfer organization owner",
      description:
        "Transfer organization ownership to an active organization member through the backend workspace API. The previous owner remains an organization admin.",
      inputSchema: {
        organizationId: z.string(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ organizationId, organizationMemberId, userId }) => {
      try {
        if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
        const result = await eb.transferOrganizationOwner({ organizationId, organizationMemberId, userId });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "deactivate_organization_member",
    {
      title: "Deactivate organization member",
      description:
        "Deactivate an organization member through the backend workspace API. Deactivated members cannot bootstrap into organization workspaces.",
      inputSchema: {
        organizationId: z.string(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ organizationId, organizationMemberId, userId }) => {
      try {
        if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
        const result = await eb.deactivateOrganizationMember({ organizationId, organizationMemberId, userId });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "reactivate_organization_member",
    {
      title: "Reactivate organization member",
      description:
        "Reactivate an organization member through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ organizationId, organizationMemberId, userId }) => {
      try {
        if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
        const result = await eb.reactivateOrganizationMember({ organizationId, organizationMemberId, userId });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "remove_organization_member",
    {
      title: "Remove organization member",
      description:
        "Remove an organization member from the account through the backend workspace API. This also reassigns their page/block/comment/file ownership metadata to an active non-guest organization member, removes organization workspace memberships, revokes pending invitations for the same email, and removes direct page permissions in the organization. Workspace owners must transfer ownership first.",
      inputSchema: {
        organizationId: z.string(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
        reassignToOrganizationMemberId: z.string().optional(),
        reassignToUserId: z.string().optional(),
      },
    },
    async ({ organizationId, organizationMemberId, userId, reassignToOrganizationMemberId, reassignToUserId }) => {
      try {
        if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
        const result = await eb.removeOrganizationMember({
          organizationId,
          organizationMemberId,
          userId,
          reassignToOrganizationMemberId,
          reassignToUserId,
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_organization_group",
    {
      title: "Create organization group",
      description:
        "Create a reusable organization group/team through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        name: z.string(),
        description: z.string().nullable().optional(),
      },
    },
    async ({ organizationId, name, description }) => {
      try {
        const result = await eb.createOrganizationGroup({ organizationId, name, description });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_organization_group",
    {
      title: "Update organization group",
      description:
        "Rename or update a reusable organization group/team through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationGroupId: z.string().optional(),
        name: z.string().optional(),
        currentName: z.string().optional(),
        description: z.string().nullable().optional(),
      },
    },
    async ({ organizationId, organizationGroupId, name, currentName, description }) => {
      try {
        if (!organizationGroupId && !currentName) throw new Error("Provide organizationGroupId or currentName.");
        if (name === undefined && description === undefined) {
          throw new Error("Provide name or description.");
        }
        const result = await eb.updateOrganizationGroup({
          organizationId,
          organizationGroupId,
          currentName,
          ...(name !== undefined ? { name } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_organization_group",
    {
      title: "Delete organization group",
      description:
        "Delete an organization group/team through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationGroupId: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async ({ organizationId, organizationGroupId, name }) => {
      try {
        if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
        const result = await eb.deleteOrganizationGroup({ organizationId, organizationGroupId, name });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "add_organization_group_member",
    {
      title: "Add organization group member",
      description:
        "Add an active organization member to an organization group/team through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationGroupId: z.string().optional(),
        name: z.string().optional(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ organizationId, organizationGroupId, name, organizationMemberId, userId }) => {
      try {
        if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
        if (!organizationMemberId && !userId) throw new Error("Provide organizationMemberId or userId.");
        const result = await eb.addOrganizationGroupMember({
          organizationId,
          organizationGroupId,
          name,
          organizationMemberId,
          userId,
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "remove_organization_group_member",
    {
      title: "Remove organization group member",
      description:
        "Remove a member from an organization group/team through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationGroupId: z.string().optional(),
        name: z.string().optional(),
        organizationGroupMemberId: z.string().optional(),
        organizationMemberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({
      organizationId,
      organizationGroupId,
      name,
      organizationGroupMemberId,
      organizationMemberId,
      userId,
    }) => {
      try {
        if (!organizationGroupId && !name) throw new Error("Provide organizationGroupId or name.");
        if (!organizationGroupMemberId && !organizationMemberId && !userId) {
          throw new Error("Provide organizationGroupMemberId, organizationMemberId, or userId.");
        }
        const result = await eb.removeOrganizationGroupMember({
          organizationId,
          organizationGroupId,
          name,
          organizationGroupMemberId,
          organizationMemberId,
          userId,
        });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "add_organization_domain",
    {
      title: "Add organization domain",
      description:
        "Add a pending organization email domain through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        domain: z.string(),
      },
    },
    async ({ organizationId, domain }) => {
      try {
        const result = await eb.addOrganizationDomain({ organizationId, domain });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "verify_organization_domain",
    {
      title: "Verify organization domain",
      description:
        "Mark an organization domain verified through the backend workspace API. This is a manual verification placeholder for local/product administration.",
      inputSchema: {
        organizationId: z.string(),
        organizationDomainId: z.string().optional(),
        domain: z.string().optional(),
      },
    },
    async ({ organizationId, organizationDomainId, domain }) => {
      try {
        if (!organizationDomainId && !domain) throw new Error("Provide organizationDomainId or domain.");
        const result = await eb.verifyOrganizationDomain({ organizationId, organizationDomainId, domain });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "remove_organization_domain",
    {
      title: "Remove organization domain",
      description:
        "Remove an organization domain through the backend workspace API.",
      inputSchema: {
        organizationId: z.string(),
        organizationDomainId: z.string().optional(),
        domain: z.string().optional(),
      },
    },
    async ({ organizationId, organizationDomainId, domain }) => {
      try {
        if (!organizationDomainId && !domain) throw new Error("Provide organizationDomainId or domain.");
        const result = await eb.removeOrganizationDomain({ organizationId, organizationDomainId, domain });
        return ok(organizationMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_workspace",
    {
      title: "Create workspace",
      description:
        "Create a new owner workspace through the backend workspace API. The MCP current workspace is not switched automatically.",
      inputSchema: {
        name: z.string().min(1),
        icon: z.string().optional(),
        domain: z.string().optional().describe("Optional workspace URL slug"),
        organizationId: z.string().optional().describe("Optional organization/account id"),
      },
    },
    async ({ name, icon, domain, organizationId }) => {
      try {
        const result = await eb.createWorkspace({ name, icon, domain, organizationId });
        return ok(workspaceLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_workspace",
    {
      title: "Delete workspace",
      description:
        "Delete an owner-only empty workspace through the backend workspace API. Populated workspaces are rejected until full workspace archival is implemented.",
      inputSchema: {
        workspaceId: z.string(),
      },
    },
    async ({ workspaceId }) => {
      try {
        const result = await eb.deleteWorkspace(workspaceId);
        return ok(workspaceLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_workspace_members",
    {
      title: "List workspace members",
      description: "List workspace members through the backend workspace API.",
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async ({ workspaceId }) => {
      try {
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.workspaceMembers(workspace.id);
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "add_workspace_member",
    {
      title: "Add workspace member",
      description:
        "Add an existing server account to a workspace, or update an existing workspace member, through the backend workspace API. An unknown email is handled as a blind no-op so this tool cannot be used to discover whether an account exists.",
      inputSchema: {
        workspaceId: z.string().optional(),
        userId: z.string().optional().describe("Known EdgeBase user id to add to the workspace"),
        displayName: z.string().optional(),
        email: z.string().optional().describe("Exact email of an existing server account when userId is not known"),
        role: z.enum(WORKSPACE_MEMBER_ROLES).optional(),
      },
    },
    async ({ workspaceId, userId, displayName, email, role }) => {
      try {
        if (!userId && !email) throw new Error("Provide userId or email.");
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.addWorkspaceMember({
          workspaceId: workspace.id,
          userId,
          displayName,
          email,
          role,
        });
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_my_workspace_profile",
    {
      title: "Update my workspace profile",
      description:
        "Update the current user's workspace display name or email through the backend workspace API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        displayName: z.string().optional(),
        email: z.string().optional(),
      },
    },
    async ({ workspaceId, displayName, email }) => {
      try {
        if (displayName === undefined && email === undefined) {
          throw new Error("Provide displayName or email.");
        }
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.updateMyWorkspaceProfile({
          workspaceId: workspace.id,
          displayName,
          email,
        });
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_workspace_member_role",
    {
      title: "Update workspace member role",
      description: "Change a workspace member role through the backend workspace API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        memberId: z.string().optional(),
        userId: z.string().optional(),
        role: z.enum(WORKSPACE_MEMBER_ROLES),
      },
    },
    async ({ workspaceId, memberId, userId, role }) => {
      try {
        if (!memberId && !userId) throw new Error("Provide memberId or userId.");
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.updateWorkspaceMemberRole({
          workspaceId: workspace.id,
          memberId,
          userId,
          role,
        });
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "transfer_workspace_owner",
    {
      title: "Transfer workspace owner",
      description:
        "Transfer workspace ownership to another existing workspace member through the backend workspace API. The previous owner remains a workspace admin.",
      inputSchema: {
        workspaceId: z.string().optional(),
        memberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ workspaceId, memberId, userId }) => {
      try {
        if (!memberId && !userId) throw new Error("Provide memberId or userId.");
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.transferWorkspaceOwner({
          workspaceId: workspace.id,
          memberId,
          userId,
        });
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "remove_workspace_member",
    {
      title: "Remove workspace member",
      description: "Remove a user from the workspace through the backend workspace API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        memberId: z.string().optional(),
        userId: z.string().optional(),
      },
    },
    async ({ workspaceId, memberId, userId }) => {
      try {
        if (!memberId && !userId) throw new Error("Provide memberId or userId.");
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.removeWorkspaceMember({
          workspaceId: workspace.id,
          memberId,
          userId,
        });
        return ok(workspaceMemberLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search pages",
      description: "Full-text search page titles. Returns matching pages with their ids.",
      inputSchema: {
        query: z.string().describe("Search text"),
        workspaceId: z.string().optional().describe("Optional workspace id to search within"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum pages to return"),
      },
    },
    async ({ query, workspaceId, limit }) => {
      try {
        const hits = await eb.searchPages(query, { workspaceId, limit });
        if (hits.length === 0) return ok(`No pages match "${query}".`);
        return ok(hits.map((p) => `- ${titleOf(p)}  (id: ${p.id})`).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "search_blocks",
    {
      title: "Search blocks",
      description:
        "Full-text search page body blocks through the product API. Returns only blocks visible to the current MCP user.",
      inputSchema: {
        query: z.string().describe("Search text"),
        workspaceId: z.string().optional().describe("Optional workspace id to search within"),
        limit: z.number().int().min(1).max(100).optional().describe("Maximum blocks to return"),
      },
    },
    async ({ query, workspaceId, limit }) => {
      try {
        const hits = await eb.searchBlocks(query, { workspaceId, limit });
        if (hits.length === 0) return ok(`No blocks match "${query}".`);
        return ok(
          hits
            .map((block) =>
              `- ${blockPreview(block)}  (page id: ${block.pageId}, block id: ${block.id}, type: ${block.type})`
            )
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "List pages. With no parentId, lists top-level pages. With a parentId, lists that page's sub-pages.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
        parentId: z.string().optional().describe("Parent page id; omit for top-level pages"),
      },
    },
    async ({ workspaceId, parentId }) => {
      try {
        const all = await eb.pageProjection({ workspaceId });
        const children = all.filter((p) =>
          parentId ? p.parentId === parentId : p.parentType === "workspace" || p.parentId == null
        );
        if (children.length === 0) return ok("No pages here.");
        return ok(
          children
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((p) => {
              const kids = all.filter((c) => c.parentId === p.id).length;
              return `- ${titleOf(p)}${p.kind === "database" ? " [database]" : ""}${
                kids ? ` (${kids} sub-pages)` : ""
              }  (id: ${p.id})`;
            })
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "import_markdown_page",
    {
      title: "Import Markdown page",
      description:
        "Import Markdown as a Hanji page through the backend product API. Supports headings, lists, to-dos, quotes, code, and nested list indentation.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        parentId: z.string().optional().describe("Parent page/database id; omit for workspace root"),
        parentType: z.enum(PAGE_PARENT_TYPES).optional().describe("Parent type; defaults to page when parentId is set, otherwise workspace"),
        title: z.string().optional().describe("Imported page title"),
        position: z.number().optional().describe("Optional sibling position"),
        markdown: z.string().describe("Markdown body to import"),
      },
    },
    async ({ workspaceId, parentId, parentType, title, position, markdown }) => {
      try {
        const result = await eb.importMarkdownPage({
          workspaceId,
          parentId,
          parentType,
          title,
          position,
          markdown,
        });
        const page = result.page ?? {};
        return ok(
          `Imported Markdown page "${titleOf(page)}".\n` +
            `page id: ${page.id}\n` +
            `blocks: ${result.count ?? result.blocks?.length ?? 0}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "import_csv_database",
    {
      title: "Import CSV database",
      description:
        "Import CSV as a typed Hanji database through the backend product API. The first row is used as headers and column types are inferred.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        parentId: z.string().optional().describe("Parent page id; omit for workspace root"),
        parentType: z.enum(["workspace", "page"]).optional().describe("Parent type; defaults to page when parentId is set, otherwise workspace"),
        title: z.string().optional().describe("Imported database title"),
        position: z.number().optional().describe("Optional sibling position"),
        csv: z.string().describe("CSV text to import"),
      },
    },
    async ({ workspaceId, parentId, parentType, title, position, csv }) => {
      try {
        const result = await eb.importCsvDatabase({
          workspaceId,
          parentId,
          parentType,
          title,
          position,
          csv,
        });
        const page = result.page ?? {};
        const props = Array.isArray(result.properties) ? result.properties : [];
        const propText = props.length ? props.map(schemaLine).join("\n") : "_No properties_";
        return ok(
          `Imported CSV database "${titleOf(page)}".\n` +
            `database id: ${page.id}\n` +
            `rows: ${result.count ?? result.rows?.length ?? 0}\n\n` +
            `## Properties\n${propText}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "begin_notion_oauth_connection",
    {
      title: "Begin Notion OAuth connection",
      description:
        "Create a signed Notion OAuth authorization URL for a Hanji workspace. Open the URL in a browser, then complete with the returned code and state.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        name: z.string().optional().describe("Human-readable connection name to store after OAuth completes"),
        redirectUri: z.string().describe("Redirect URI registered in the Notion public connection settings"),
      },
    },
    async ({ workspaceId, name, redirectUri }) => {
      try {
        const result = await eb.beginNotionOAuthConnection({ workspaceId, name, redirectUri });
        return ok(
          `authorization url: ${result.authorizationUrl ?? ""}` +
            `\nredirect uri: ${result.redirectUri ?? ""}` +
            `\nexpires at: ${result.expiresAt ?? ""}` +
            `\nstate: ${result.state ?? ""}`,
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "complete_notion_oauth_connection",
    {
      title: "Complete Notion OAuth connection",
      description:
        "Exchange a Notion OAuth callback code and signed state for an encrypted Notion import connection.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        code: z.string().describe("Authorization code returned by Notion"),
        state: z.string().describe("Signed state returned by Notion"),
        redirectUri: z.string().optional().describe("Redirect URI used in the authorization request"),
        name: z.string().optional().describe("Optional connection name override"),
      },
    },
    async ({ workspaceId, code, state, redirectUri, name }) => {
      try {
        const result = await eb.completeNotionOAuthConnection({ workspaceId, code, state, redirectUri, name });
        return ok(notionImportConnectionSummary(result.connection));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_notion_import_connection",
    {
      title: "Create Notion import connection",
      description:
        "Store an encrypted Notion API connection for a Hanji workspace. Requires the backend HANJI_NOTION_IMPORT_SECRET to be configured.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        name: z.string().optional().describe("Human-readable connection name"),
        connectionKind: z.enum(NOTION_IMPORT_CONNECTION_KINDS).optional().describe("Notion connection kind"),
        notionToken: z.string().describe("Notion API token to validate and store encrypted on the backend"),
      },
    },
    async ({ workspaceId, name, connectionKind, notionToken }) => {
      try {
        const result = await eb.createNotionImportConnection({
          workspaceId,
          name,
          connectionKind,
          notionToken,
        });
        return ok(notionImportConnectionSummary(result.connection));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_notion_import_connections",
    {
      title: "List Notion import connections",
      description: "List stored Notion API import connections for a Hanji workspace without exposing credentials.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        limit: z.number().optional().describe("Maximum number of connections to return"),
      },
    },
    async ({ workspaceId, limit }) => {
      try {
        const result = await eb.listNotionImportConnections({ workspaceId, limit });
        const connections = Array.isArray(result.connections) ? result.connections : [];
        if (connections.length === 0) return ok("No Notion import connections.");
        return ok(connections.map(notionImportConnectionSummary).join("\n\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "revoke_notion_import_connection",
    {
      title: "Revoke Notion import connection",
      description: "Revoke a stored Notion API import connection and remove its encrypted credential.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        connectionId: z.string().describe("Notion import connection id"),
      },
    },
    async ({ workspaceId, connectionId }) => {
      try {
        const result = await eb.revokeNotionImportConnection({ workspaceId, connectionId });
        return ok(notionImportConnectionSummary(result.connection));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_notion_import_job",
    {
      title: "Create Notion API import job",
      description:
        "Create a Notion API import job through the Hanji product API. When a Notion token is provided, the backend performs the first accessible workspace discovery pass without storing the token.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        parentPageId: z.string().optional().describe("Optional Hanji parent page id for imported content"),
        connectionKind: z.enum(NOTION_IMPORT_CONNECTION_KINDS).optional().describe("Notion connection kind"),
        connectionId: z.string().optional().describe("Stored Notion import connection id for discovery"),
        notionToken: z.string().optional().describe("Optional Notion API token for immediate discovery; not stored"),
        rootNotionPageIds: z.array(z.string()).optional().describe("Optional Notion root page ids to prioritize"),
        snapshotItems: z.array(JsonObjectSchema).optional().describe("Optional pre-fetched Notion API graph snapshot items"),
        maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
        maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
        maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
        maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
        maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
        copyFilesToStorage: z.boolean().optional().describe("Whether apply should copy imported Notion file references into EdgeBase storage. Defaults to true."),
      },
    },
    async ({
      workspaceId,
      parentPageId,
      connectionKind,
      connectionId,
      notionToken,
      rootNotionPageIds,
      snapshotItems,
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      copyFilesToStorage,
    }) => {
      try {
        const result = await eb.createNotionImportJob({
          workspaceId,
          parentPageId,
          connectionKind,
          connectionId,
          notionToken,
          rootNotionPageIds,
          snapshotItems,
          maxDiscoveryPages,
          maxEnrichedItems,
          maxChildrenPages,
          maxDataSourceQueryPages,
          maxViewPages,
          copyFilesToStorage,
        });
        return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_notion_import_jobs",
    {
      title: "List Notion import jobs",
      description: "List recent Notion API import jobs for a Hanji workspace.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        limit: z.number().optional().describe("Maximum number of jobs to return"),
      },
    },
    async ({ workspaceId, limit }) => {
      try {
        const result = await eb.listNotionImportJobs({ workspaceId, limit });
        const jobs = Array.isArray(result.jobs) ? result.jobs : [];
        if (jobs.length === 0) return ok("No Notion import jobs.");
        return ok(jobs.map(notionImportJobSummary).join("\n\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_notion_import_job",
    {
      title: "Get Notion import job",
      description: "Inspect a Notion API import job and its discovered Notion items.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Notion import job id"),
      },
    },
    async ({ workspaceId, jobId }) => {
      try {
        const result = await eb.getNotionImportJob({ workspaceId, jobId });
        return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "plan_notion_import_job",
    {
      title: "Review Notion import job",
      description:
        "Dry-run a ready Notion API import job and return estimated local writes plus conversion issues before applying it.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Ready Notion import job id"),
      },
    },
    async ({ workspaceId, jobId }) => {
      try {
        const result = await eb.planNotionImportJob({ workspaceId, jobId });
        return ok(notionImportJobSummary(result.job) + "\n\n" + notionImportPlanSummary(result.plan));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "discover_notion_import_job",
    {
      title: "Discover Notion import graph",
      description:
        "Run the Notion API discovery pass for an existing import job with a one-time token or stored connection id.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Notion import job id"),
        notionToken: z.string().optional().describe("One-time Notion API token; not stored"),
        connectionId: z.string().optional().describe("Stored Notion import connection id"),
        maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
        maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
        maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
        maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
        maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
        continueFromCursor: z.boolean().optional().describe("Continue from the job's saved Notion search cursor and merge newly discovered items instead of replacing the graph"),
      },
    },
    async ({
      workspaceId,
      jobId,
      notionToken,
      connectionId,
      maxDiscoveryPages,
      maxEnrichedItems,
      maxChildrenPages,
      maxDataSourceQueryPages,
      maxViewPages,
      continueFromCursor,
    }) => {
      try {
        const result = await eb.discoverNotionImportJob({
          workspaceId,
          jobId,
          notionToken,
          connectionId,
          maxDiscoveryPages,
          maxEnrichedItems,
          maxChildrenPages,
          maxDataSourceQueryPages,
          maxViewPages,
          continueFromCursor,
        });
        return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "cancel_notion_import_job",
    {
      title: "Cancel Notion import job",
      description: "Cancel a queued or active Notion API import job.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Notion import job id"),
      },
    },
    async ({ workspaceId, jobId }) => {
      try {
        const result = await eb.cancelNotionImportJob({ workspaceId, jobId });
        return ok(notionImportJobSummary(result.job));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "apply_notion_import_job",
    {
      title: "Apply Notion import job",
      description:
        "Apply a ready Notion API import job into local Hanji pages, canonical databases, views, rows, blocks, file uploads, and durable mappings.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Ready Notion import job id"),
      },
    },
    async ({ workspaceId, jobId }) => {
      try {
        const result = await eb.applyNotionImportJob({ workspaceId, jobId });
        const applied = result.applied ?? {};
        return ok(
          notionImportJobSummary(result.job) +
            `\n\napplied pages: ${applied.pages ?? 0}` +
            `\napplied databases: ${applied.databases ?? 0}` +
            `\napplied rows: ${applied.rows ?? 0}` +
            `\napplied properties: ${applied.properties ?? 0}` +
            `\napplied views: ${applied.views ?? 0}` +
            `\napplied blocks: ${applied.blocks ?? 0}` +
            `\nfile copies: ${applied.fileCopies ?? 0}` +
            `\nfile copy skipped: ${applied.fileCopySkipped ?? 0}`,
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "retry_notion_import_file_copies",
    {
      title: "Retry Notion import file copies",
      description:
        "Retry copying skipped Notion file references from a completed import job into EdgeBase storage without creating a new import job.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Completed Notion import job id"),
      },
    },
    async ({ workspaceId, jobId }) => {
      try {
        const result = await eb.retryNotionImportFileCopies({ workspaceId, jobId });
        const retry = result.fileRetry ?? {};
        return ok(
          notionImportJobSummary(result.job) +
            `\n\nfile references scanned: ${retry.scanned ?? 0}` +
            `\nfile copies: ${retry.copied ?? 0}` +
            `\nfile copy skipped: ${retry.skipped ?? 0}`,
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "retry_notion_import_job",
    {
      title: "Retry Notion import job",
      description:
        "Create a retry job from a previous Notion API import job. Provide a token to run discovery immediately.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
        jobId: z.string().describe("Previous Notion import job id"),
        notionToken: z.string().optional().describe("Optional Notion API token for immediate discovery; not stored"),
        connectionId: z.string().optional().describe("Optional stored Notion import connection id for immediate discovery"),
        maxDiscoveryPages: z.number().optional().describe("Number of Notion search pages to scan, max 20"),
        maxEnrichedItems: z.number().optional().describe("Number of discovered search items to enrich with graph snapshots, max 50"),
        maxChildrenPages: z.number().optional().describe("Number of block-children pages to read per Notion page, max 3"),
        maxDataSourceQueryPages: z.number().optional().describe("Number of data source query pages to read per data source, max 2"),
        maxViewPages: z.number().optional().describe("Number of view-list pages to read per data source, max 3"),
      },
    },
    async ({ workspaceId, jobId, notionToken, connectionId, maxDiscoveryPages, maxEnrichedItems, maxChildrenPages, maxDataSourceQueryPages, maxViewPages }) => {
      try {
        const result = await eb.retryNotionImportJob({
          workspaceId,
          jobId,
          notionToken,
          connectionId,
          maxDiscoveryPages,
          maxEnrichedItems,
          maxChildrenPages,
          maxDataSourceQueryPages,
          maxViewPages,
        });
        return ok(notionImportJobSummary(result.job) + notionImportItemPreview(result.items));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "export_page_markdown",
    {
      title: "Export page Markdown",
      description:
        "Export a page or database as Markdown through the backend product API. Database pages include a Markdown table of visible rows plus row-page body and child-page sections.",
      inputSchema: {
        pageId: z.string().describe("Page or database id to export"),
      },
    },
    async ({ pageId }) => {
      try {
        const result = await eb.exportPageMarkdown(pageId);
        const page = result.page ?? {};
        return ok(`Exported "${titleOf(page)}".\npage id: ${page.id}\n\n${result.markdown ?? ""}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "export_database_csv",
    {
      title: "Export database CSV",
      description:
        "Export a database as CSV through the backend product API. File properties include signed URLs when available.",
      inputSchema: {
        databaseId: z.string().describe("Database id to export"),
      },
    },
    async ({ databaseId }) => {
      try {
        const result = await eb.exportDatabaseCsv(databaseId);
        const page = result.page ?? {};
        return ok(
          `Exported CSV "${titleOf(page)}".\n` +
            `database id: ${page.id}\n` +
            `rows: ${result.rowCount ?? 0}\n\n` +
            `${result.csv ?? ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "export_workspace_markdown",
    {
      title: "Export workspace Markdown",
      description:
        "Export an accessible workspace page tree as Markdown through the backend product API. Includes nested pages, database tables, and database row-page sections.",
      inputSchema: {
        workspaceId: z.string().optional().describe("Workspace id; defaults to the current workspace"),
      },
    },
    async ({ workspaceId }) => {
      try {
        const result = await eb.exportWorkspaceMarkdown({ workspaceId });
        const workspace = result.workspace ?? {};
        return ok(
          `Exported workspace "${workspace.name || workspace.domain || workspace.id || "unknown"}".\n` +
            `workspace id: ${workspace.id}\n` +
            `pages: ${result.pageCount ?? 0}\n\n` +
            `${result.markdown ?? ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_database",
    {
      title: "Create database",
      description:
        "Create a database page through the backend product API with default or custom properties, an initial view, and optional starter rows.",
      inputSchema: {
        title: z.string().optional().describe("Database title; defaults to Untitled"),
        parentId: z.string().optional().describe("Parent page id; omit for a top-level database"),
        parentType: z.enum(["workspace", "page"]).optional().describe("Destination type; defaults to page when parentId is set"),
        viewType: z.enum(DATABASE_VIEW_TYPES).optional().describe("Initial view type"),
        seedRows: z.boolean().optional().describe("Create three empty starter rows; default true"),
        properties: z.array(createDatabasePropertyInputSchema).optional().describe("Optional custom schema. If no title property is included, a title property is added automatically."),
      },
    },
    async ({ title, parentId, parentType, viewType = "table", seedRows = true, properties }) => {
      try {
        const { parentId: cleanParentId, parentType: cleanParentType } = normalizeParentInput(parentId, parentType);
        const result = await eb.createDatabase({
          parentId: cleanParentId,
          parentType: cleanParentType,
          title: title ?? "Untitled",
          viewType,
          seedRows,
          properties,
        });
        const db = result.page;
        const view = result.views?.[0];
        const props = result.properties ?? [];
        const rowCount = result.rows?.length ?? 0;

        return ok(
          `Created database "${titleOf(db)}".\n` +
            `database id: ${db.id}\n` +
            `view: ${view?.name ?? databaseViewLabel(viewType)} [${view?.type ?? viewType}] id: ${view?.id ?? "unknown"}\n` +
            `rows: ${rowCount}\n\n` +
            `## Properties\n${props.map(schemaLine).join("\n")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "_notion_create_database",
    {
      title: "Create database",
      description:
        "Notion-compatible database creation using a SQL DDL CREATE TABLE schema. Hanji MCP is account-scoped, so workspace_id is required. Hanji creates one local data source per database.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
        teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
        title: z.string().optional(),
        description: z.string().optional(),
        parent: z.object({
          type: z.string().optional(),
          page_id: z.string().optional(),
        }).optional(),
        schema: z.string().describe('CREATE TABLE statement, e.g. CREATE TABLE ("Name" TITLE, "Status" SELECT(...))'),
      },
    },
    async ({ workspace_id, teamspace_id, title, description, parent, schema }) => {
      try {
        const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_database");
        if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
        const properties = parseNotionCreateTableSchema(schema);
        const parentId = parent?.page_id ? stripHanjiId(parent.page_id) : null;
        if (parentId) {
          const parentPage = await eb.getOne("pages", parentId);
          if (!parentPage || !parentPage.id) throw new Error(`Parent page ${parentId} not found.`);
          const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parentPage, "_notion_create_database", "Parent page");
          if (matched.errorResult) return matched.errorResult;
        }
        const result = await eb.createDatabase({
          workspaceId: requiredWorkspace.workspaceId,
          parentId,
          parentType: parentId ? "page" : "workspace",
          title: title ?? "Untitled",
          viewType: "table",
          seedRows: false,
          properties,
        });
        const payload = await notionDataSourceFetchPayload(result.page);
        const notes = description ? "\n\nNote: Hanji does not currently store a separate data-source description field." : "";
        return ok(`${payload.text}${notes}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_databases",
    {
      title: "List databases",
      description: "List local Hanji databases with ids and row counts.",
      inputSchema: {},
    },
    async () => {
      try {
        const databases = (await eb.pages()).filter((page) => page.kind === "database");
        if (databases.length === 0) return ok("No databases found.");
        const rowsByDb = await Promise.all(databases.map((db) => eb.dbRows(db.id)));
        const rowCounts = Object.fromEntries(databases.map((db, index) => [db.id, rowsByDb[index].length]));
        return ok(
          databases
            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
            .map((db) => `- ${titleOf(db)} (${rowCounts[db.id] ?? 0} rows)  id: ${db.id}`)
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
