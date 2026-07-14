export function registerNotionTools(runtime) {
  const {
    FILE_UPLOAD_STATUSES,
    MCP_ACTOR,
    NOTIFICATION_KINDS,
    NOTION_CREATE_COMMENT_TOOL,
    NOTION_CREATE_PAGES_TOOL,
    NOTION_DUPLICATE_PAGE_TOOL,
    NOTION_GET_COMMENTS_TOOL,
    NOTION_MOVE_PAGES_TOOL,
    NOTION_UPDATE_PAGE_TOOL,
    PAGE_FONTS,
    PAGE_ICON_TYPES,
    PAGE_PARENT_TYPES,
    PAGE_TEMPLATES,
    SHARE_PRINCIPAL_TYPES,
    SHARE_ROLES,
    appendMarkdown,
    blocksToMarkdown,
    collectPageSubtree,
    commentLine,
    countTemplateBlocks,
    deletePageTree,
    eb,
    fail,
    fileReportLines,
    fileUploadLines,
    handleNotionCreateComment,
    handleNotionCreatePages,
    handleNotionDuplicatePage,
    handleNotionGetComments,
    handleNotionMovePages,
    handleNotionUpdatePage,
    hasTrashedAncestor,
    insertTemplateBlocks,
    lockedPageMessage,
    movePage,
    notificationListLines,
    ok,
    pageAccessLines,
    pageCreateAudit,
    pageEditAudit,
    pageIconPatch,
    pagePresentationPatch,
    registerToolAliases,
    replaceMarkdown,
    restorePageTree,
    server,
    shareRoleLabel,
    stripHanjiId,
    titleOf,
    trashPageTree,
    z,
  } = runtime;

  registerToolAliases(["create_pages", "_notion_create_pages"], NOTION_CREATE_PAGES_TOOL, handleNotionCreatePages);

  server.registerTool(
    "create_page",
    {
      title: "Create page",
      description:
        "Create a new page. Optionally nest it under a parent page, set page appearance, and seed it with Markdown content.",
      inputSchema: {
        title: z.string().describe("Page title"),
        parentId: z.string().optional().describe("Parent page id; omit for a top-level page"),
        icon: z.string().optional().describe("Emoji icon or image URL. Pass an empty string for no icon."),
        iconType: z.enum(PAGE_ICON_TYPES).optional().describe("Icon type. Defaults to image for URLs and emoji otherwise."),
        cover: z.string().optional().describe("Cover image URL or CSS gradient. Pass an empty string for no cover."),
        coverPosition: z.number().min(0).max(100).optional().describe("Cover vertical position from 0 to 100"),
        workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
        font: z.enum(PAGE_FONTS).optional().describe("Page font"),
        smallText: z.boolean().optional().describe("Use Notion-style small text"),
        fullWidth: z.boolean().optional().describe("Use the full-width page layout"),
        locked: z.boolean().optional().describe("Create the page locked"),
        content: z.string().optional().describe("Initial body content as Markdown"),
      },
    },
    async ({ title, parentId, icon, iconType, cover, coverPosition, workspaceId, font, smallText, fullWidth, locked, content }) => {
      try {
        const ws = workspaceId ? { id: workspaceId } : await eb.workspace();
        const pages = await eb.pageProjection({ workspaceId: ws.id });
        const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
        if (parentId) {
          const parent = pagesById[parentId];
          if (!parent || parent.inTrash) return ok(`Parent page ${parentId} not found.`);
          if (parent.kind !== "page") return ok(`Parent ${parentId} is not a page.`);
          if (parent.isLocked) return ok(lockedPageMessage(parent));
        }
        const id = eb.newId();
        const iconPatch = pageIconPatch({ icon, iconType });
        // Position = max sibling position + 1 (stable append order; no collisions).
        const siblings = pages.filter((p) =>
          parentId ? p.parentId === parentId : p.parentType === "workspace" || p.parentId == null
        );
        const position = siblings.reduce((m, p) => Math.max(m, p.position ?? 0), 0) + 1;
        await eb.insert("pages", {
          id,
          workspaceId: ws.id,
          parentId: parentId ?? null,
          parentType: parentId ? "page" : "workspace",
          kind: "page",
          title,
          icon: "",
          iconType: "none",
          position,
          font: "default",
          smallText: false,
          fullWidth: false,
          isFavorite: false,
          isPublic: false,
          inTrash: false,
          backlinksDisplay: "default",
          pageCommentsDisplay: "default",
          ...pageCreateAudit(),
          ...iconPatch,
          ...pagePresentationPatch({ cover, coverPosition, font, smallText, fullWidth, locked }),
        });
        let added = 0;
        if (content) added = await appendMarkdown(id, content);
        return ok(`Created page "${title}" (id: ${id})${added ? `, added ${added} blocks` : ""}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_page_templates",
    {
      title: "List page templates",
      description: "List built-in local page templates available in the web sidebar.",
      inputSchema: {
        category: z.string().optional().describe("Optional category filter, e.g. Personal or Work"),
      },
    },
    async ({ category }) => {
      try {
        const needle = String(category ?? "").trim().toLowerCase();
        const templates = needle
          ? PAGE_TEMPLATES.filter((template) => template.category.toLowerCase() === needle)
          : PAGE_TEMPLATES;
        if (templates.length === 0) return ok(`No page templates${category ? ` in ${category}` : ""}.`);
        return ok(
          templates
            .map(
              (template) =>
                `- ${template.icon} ${template.title}  id: ${template.id}  category: ${template.category}  blocks: ${countTemplateBlocks(template.blocks)}`
            )
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_page_from_template",
    {
      title: "Create page from template",
      description: "Create a top-level page from one of the built-in local page templates.",
      inputSchema: {
        templateId: z.string().describe("Template id from list_page_templates"),
        workspaceId: z.string().optional().describe("Optional workspace id; defaults to the current workspace"),
        title: z.string().optional().describe("Optional custom page title; defaults to the template title"),
      },
    },
    async ({ templateId, workspaceId, title }) => {
      try {
        const template = PAGE_TEMPLATES.find((item) => item.id === templateId);
        if (!template) return ok(`Template ${templateId} not found. Call list_page_templates first.`);
        const ws = workspaceId ? { id: workspaceId } : await eb.workspace();
        const id = eb.newId();
        const pages = await eb.pageProjection({ workspaceId: ws.id });
        const position =
          pages
            .filter((page) => page.parentType === "workspace" || page.parentId == null)
            .reduce((max, page) => Math.max(max, page.position ?? 0), 0) + 1;
        const pageTitle = title ?? template.title;
        await eb.insert("pages", {
          id,
          workspaceId: ws.id,
          parentId: null,
          parentType: "workspace",
          kind: "page",
          title: pageTitle,
          icon: template.icon,
          iconType: "emoji",
          position,
          isFavorite: false,
          isPublic: false,
          inTrash: false,
          font: "default",
          smallText: false,
          fullWidth: false,
          backlinksDisplay: "default",
          pageCommentsDisplay: "default",
          ...pageCreateAudit(),
        });
        const inserted = await insertTemplateBlocks(id, template.blocks);
        return ok(`Created page "${pageTitle}" from ${template.title} (id: ${id}), added ${inserted.length} blocks.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["duplicate_page", "_notion_duplicate_page"], NOTION_DUPLICATE_PAGE_TOOL, handleNotionDuplicatePage);

  server.registerTool(
    "set_page_lock",
    {
      title: "Set page lock",
      description: "Lock or unlock a page. Locked pages can be read, moved, favorited, or trashed, but not edited.",
      inputSchema: {
        pageId: z.string(),
        locked: z.boolean().describe("true to lock the page; false to unlock it"),
      },
    },
    async ({ pageId, locked }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        await eb.update("pages", pageId, { isLocked: locked, ...pageEditAudit() });
        return ok(`${locked ? "Locked" : "Unlocked"} "${titleOf(page)}".`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "set_page_favorite",
    {
      title: "Set page favorite",
      description:
        "Add or remove a page from Favorites. This mirrors the web app's star state and is allowed even when a page is locked.",
      inputSchema: {
        pageId: z.string(),
        favorite: z.boolean().describe("true to add the page to Favorites; false to remove it"),
      },
    },
    async ({ pageId, favorite }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        const updated = await eb.update("pages", pageId, { isFavorite: favorite, ...pageEditAudit() });
        return ok(`${favorite ? "Added" : "Removed"} "${titleOf(updated)}" ${favorite ? "to" : "from"} Favorites.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "set_page_verification",
    {
      title: "Set page verification",
      description:
        "Mark a page as verified, or remove verification. This mirrors Notion's page verification metadata and is allowed even when a page is locked.",
      inputSchema: {
        pageId: z.string(),
        verified: z.boolean().describe("true to verify the page; false to remove verification"),
        expiresAt: z.string().optional().describe("Optional ISO timestamp when verification expires. Omit for no expiry."),
        verifiedBy: z.string().optional().describe("Optional verifier id/name; defaults to mcp-local"),
      },
    },
    async ({ pageId, verified, expiresAt, verifiedBy }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        const patch = verified
          ? {
              verifiedAt: new Date().toISOString(),
              verifiedBy: verifiedBy || MCP_ACTOR,
              verificationExpiresAt: expiresAt || null,
            }
          : {
              verifiedAt: null,
              verifiedBy: null,
              verificationExpiresAt: null,
            };
        const updated = await eb.update("pages", pageId, { ...patch, ...pageEditAudit() });
        return ok(`${verified ? "Verified" : "Removed verification for"} "${titleOf(updated)}".`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "set_page_web_sharing",
    {
      title: "Set page web sharing",
      description:
        "Enable or disable Notion-style Share to web through the backend sharing API. Shared pages appear in the web app's Shared sidebar section.",
      inputSchema: {
        pageId: z.string(),
        public: z.boolean().describe("true to enable Share to web; false to make the page private again"),
        expiresAt: z
          .string()
          .nullable()
          .optional()
          .describe("Optional ISO timestamp, duration like 7d/24h, or null/never to clear public link expiration."),
        expiresIn: z
          .string()
          .optional()
          .describe("Optional duration like 24h, 7d, or 30d. Ignored when expiresAt is provided."),
      },
    },
    async ({ pageId, public: isPublic, expiresAt, expiresIn }) => {
      try {
        const opts = {};
        if (expiresAt !== undefined) opts.expiresAt = expiresAt;
        else if (expiresIn !== undefined) opts.expiresIn = expiresIn;
        const result = await eb.setPageWebSharing(pageId, isPublic, opts);
        return ok(
          `${isPublic ? "Enabled Share to web for" : "Disabled Share to web for"} "${titleOf(result.page)}".\n` +
            pageAccessLines(result).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_page_access",
    {
      title: "List page access",
      description:
        "List a page's backend-backed web sharing state and explicit page permissions.",
      inputSchema: {
        pageId: z.string(),
      },
    },
    async ({ pageId }) => {
      try {
        const result = await eb.pageAccess(pageId);
        return ok(`Access for "${titleOf(result.page)}":\n${pageAccessLines(result).join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_shared_page",
    {
      title: "Get shared page",
      description:
        "Read a public Share to web page by /share/:shareId token through the backend public sharing API.",
      inputSchema: {
        shareId: z.string().describe("The token from a /share/:shareId URL"),
      },
    },
    async ({ shareId }) => {
      try {
        const result = await eb.publicSharedPage(shareId);
        const rootBlocks = (result.blocks ?? [])
          .filter((block) => block.pageId === result.page.id)
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
        const markdown = blocksToMarkdown(rootBlocks);
        return ok(
          `# ${titleOf(result.page)}\n\n` +
            `page id: ${result.page.id}\n` +
            `share id: ${result.shareLink.token}\n` +
            `included pages: ${(result.pages ?? []).length}\n` +
            `included blocks: ${(result.blocks ?? []).length}\n\n` +
            (markdown || "(empty page)")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "prepare_file_upload",
    {
      title: "Prepare file upload",
      description:
        "Create a backend-validated EdgeBase file upload grant for a workspace, page, block, database, database property, or database template target.",
      inputSchema: {
        workspaceId: z.string().optional(),
        pageId: z.string().optional(),
        blockId: z.string().optional(),
        databaseId: z.string().optional(),
        propertyId: z.string().optional(),
        templateId: z.string().optional(),
        scope: z.string().optional().describe("Upload scope, such as blocks/files, blocks/images, or database/files"),
        name: z.string().describe("Original file name"),
        size: z.number().int().positive().describe("File size in bytes"),
        contentType: z.string().optional().describe("MIME content type, such as text/plain"),
      },
    },
    async ({ workspaceId, pageId, blockId, databaseId, propertyId, templateId, scope, name, size, contentType }) => {
      try {
        const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
        const result = await eb.prepareFileUpload({
          workspaceId: routedWorkspaceId,
          pageId,
          blockId,
          databaseId,
          propertyId,
          templateId,
          scope,
          name,
          size,
          contentType,
        });
        return ok(
          `Prepared upload grant for "${result.upload?.name || name}".\n` +
            fileUploadLines(result.upload).join("\n") +
            `\nupload url: ${result.uploadUrl || "not available in this runtime"}` +
            `\nupload expires: ${result.uploadExpiresAt || result.upload?.expiresAt || "no"}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "complete_file_upload",
    {
      title: "Complete file upload",
      description:
        "Verify a previously uploaded object and finalize its backend upload record. The workspace-qualified key is required for deterministic routing.",
      inputSchema: {
        uploadId: z.string(),
        key: z.string().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
        url: z.string().optional(),
      },
    },
    async ({ uploadId, key, url }) => {
      try {
        if (!key.startsWith("workspaces/")) {
          throw new Error("Provide a workspace-qualified storage key.");
        }
        const file = await eb.completeFileUpload({ id: uploadId, key, url });
        return ok(`Completed file "${file.name || file.key}".\n${fileUploadLines(file).join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_files",
    {
      title: "List files",
      description:
        "List EdgeBase-backed file upload records for the current workspace through the backend file API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        pageId: z.string().optional(),
        blockId: z.string().optional(),
        databaseId: z.string().optional(),
        propertyId: z.string().optional(),
        templateId: z.string().optional(),
        scope: z.string().optional().describe("Optional upload scope, such as database/files or blocks/images"),
        status: z.enum(FILE_UPLOAD_STATUSES).optional(),
        includeDeleted: z.boolean().optional(),
      },
    },
    async ({ workspaceId, pageId, blockId, databaseId, propertyId, templateId, scope, status, includeDeleted }) => {
      try {
        const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
        const files = await eb.listFiles({
          workspaceId: routedWorkspaceId,
          pageId,
          blockId,
          databaseId,
          propertyId,
          templateId,
          scope,
          status,
          includeDeleted,
        });
        if (files.length === 0) return ok("No files found.");
        return ok(files.map((file) => fileUploadLines(file).join("\n")).join("\n\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete file",
      description:
        "Delete an EdgeBase-backed stored file by workspace-qualified storage key, or by upload id together with workspaceId.",
      inputSchema: {
        workspaceId: z.string().optional(),
        uploadId: z.string().optional(),
        key: z.string().optional().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
      },
    },
    async ({ workspaceId, uploadId, key }) => {
      try {
        if (!key && !(workspaceId && uploadId)) {
          throw new Error("Provide a workspace-qualified key, or provide both workspaceId and uploadId.");
        }
        if (key && !key.startsWith("workspaces/")) {
          throw new Error("Provide a workspace-qualified storage key.");
        }
        const file = await eb.deleteFile({ workspaceId, uploadId, key });
        return ok(`Deleted file "${file.name || file.key}".\n${fileUploadLines(file).join("\n")}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "cleanup_expired_files",
    {
      title: "Cleanup expired files",
      description:
        "Expire pending file upload grants whose signed upload window has elapsed, deleting any orphaned stored objects the actor can edit.",
      inputSchema: {
        workspaceId: z.string().optional(),
        limit: z.number().int().positive().max(1000).optional(),
        dryRun: z.boolean().optional(),
      },
    },
    async ({ workspaceId, limit, dryRun }) => {
      try {
        const routedWorkspaceId = workspaceId || (await eb.workspace()).id;
        const result = await eb.cleanupExpiredFiles({ workspaceId: routedWorkspaceId, limit, dryRun });
        const files = result.expired ?? [];
        if (files.length === 0) {
          return ok(
            `${result.dryRun ? "Dry run" : "Cleanup"} found no expired pending file uploads.\n` +
              `workspace id: ${result.workspaceId}\nscanned: ${result.scanned ?? 0}`
          );
        }
        return ok(
          `${result.dryRun ? "Dry run" : "Cleaned up"} ${files.length} expired file upload${files.length === 1 ? "" : "s"}.\n` +
            `workspace id: ${result.workspaceId}\nscanned: ${result.scanned ?? files.length}\n\n` +
            files.map((file) => fileUploadLines(file).join("\n")).join("\n\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_file_report",
    {
      title: "Get file report",
      description:
        "Read workspace or organization file usage analytics and recent file maintenance runs through the backend file API. Requires workspace admin or organization admin access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        organizationId: z.string().optional(),
        maintenanceLimit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ workspaceId, organizationId, maintenanceLimit }) => {
      try {
        if (workspaceId && organizationId) throw new Error("Provide workspaceId or organizationId, not both.");
        const routedWorkspaceId = workspaceId || (!organizationId ? (await eb.workspace()).id : undefined);
        const report = await eb.fileReport({ workspaceId: routedWorkspaceId, organizationId, maintenanceLimit });
        return ok(fileReportLines(report).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_notifications",
    {
      title: "List notifications",
      description:
        "List the current user's persisted Hanji notification inbox through the backend notification API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        includeRead: z.boolean().optional(),
        kind: z.enum(NOTIFICATION_KINDS).optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ workspaceId, includeRead, kind, limit }) => {
      try {
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.listNotifications({
          workspaceId: workspace.id,
          includeRead,
          kind,
          limit,
        });
        return ok(notificationListLines(result).join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "mark_notifications_read",
    {
      title: "Mark notifications read",
      description:
        "Mark one or more persisted notifications read by notification id or activity key through the backend notification API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        notificationIds: z.array(z.string()).optional(),
        activityKeys: z.array(z.string()).optional(),
      },
    },
    async ({ workspaceId, notificationIds, activityKeys }) => {
      try {
        if ((!notificationIds || notificationIds.length === 0) && (!activityKeys || activityKeys.length === 0)) {
          throw new Error("Provide notificationIds or activityKeys.");
        }
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.markNotificationsRead({
          workspaceId: workspace.id,
          notificationIds,
          activityKeys,
        });
        const updated = result.updated ?? [];
        return ok(
          `Marked ${updated.length} notification${updated.length === 1 ? "" : "s"} read.\n` +
            notificationListLines(result).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "mark_all_notifications_read",
    {
      title: "Mark all notifications read",
      description:
        "Mark every persisted notification read for the current user in a workspace through the backend notification API.",
      inputSchema: {
        workspaceId: z.string().optional(),
      },
    },
    async ({ workspaceId }) => {
      try {
        const workspace = workspaceId ? { id: workspaceId } : await eb.workspace();
        const result = await eb.markAllNotificationsRead({ workspaceId: workspace.id });
        const updated = result.updated ?? [];
        return ok(
          `Marked ${updated.length} notification${updated.length === 1 ? "" : "s"} read.\n` +
            notificationListLines(result).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_file_download_url",
    {
      title: "Create file download URL",
      description:
        "Create a short-lived signed download URL for an EdgeBase-backed file through the backend file API.",
      inputSchema: {
        workspaceId: z.string().optional(),
        uploadId: z.string().optional(),
        key: z.string().optional().describe("Workspace-qualified key beginning with workspaces/<workspaceId>/"),
        expiresIn: z.string().optional().describe("Duration such as 15m, 1h, or 1d. Defaults to 1h."),
      },
    },
    async ({ workspaceId, uploadId, key, expiresIn }) => {
      try {
        if (!key && !(workspaceId && uploadId)) {
          throw new Error("Provide a workspace-qualified key, or provide both workspaceId and uploadId.");
        }
        if (key && !key.startsWith("workspaces/")) {
          throw new Error("Provide a workspace-qualified storage key.");
        }
        const result = await eb.fileDownloadUrl({ workspaceId, uploadId, key, expiresIn });
        return ok(
          `Download URL for "${result.upload?.name || result.upload?.key || key || uploadId}":\n` +
            `${result.url}\nexpires: ${result.expiresAt}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "grant_page_access",
    {
      title: "Grant page access",
      description:
        "Grant backend-backed page access to a user, email, group, or integration.",
      inputSchema: {
        pageId: z.string(),
        label: z.string().describe("Display label or email for the grantee"),
        role: z.enum(SHARE_ROLES).describe("Permission role"),
        principalType: z.enum(SHARE_PRINCIPAL_TYPES).optional().describe("Defaults to email; use group for organization groups"),
        principalId: z.string().optional().describe("Stable grantee id; for groups, pass the organization group id"),
      },
    },
    async ({ pageId, label, role, principalType, principalId }) => {
      try {
        const result = await eb.invitePageAccess(pageId, { label, role, principalType, principalId });
        return ok(
          `Granted ${shareRoleLabel(role)} access to ${label} on "${titleOf(result.page)}".\n` +
            pageAccessLines(result).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_page_access",
    {
      title: "Update page access",
      description: "Update an existing page permission's role by permission id.",
      inputSchema: {
        permissionId: z.string(),
        role: z.enum(SHARE_ROLES),
      },
    },
    async ({ permissionId, role }) => {
      try {
        const result = await eb.updatePageAccess(permissionId, role);
        return ok(
          `Updated page access to ${shareRoleLabel(role)}.\n` +
            pageAccessLines(result).join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "revoke_page_access",
    {
      title: "Revoke page access",
      description: "Remove an explicit page permission by permission id.",
      inputSchema: {
        permissionId: z.string(),
      },
    },
    async ({ permissionId }) => {
      try {
        const result = await eb.removePageAccess(permissionId);
        return ok(
          `Revoked page access ${permissionId}.\n` +
            (result.page ? pageAccessLines(result).join("\n") : "permissions: none")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["update_page", "_notion_update_page"], NOTION_UPDATE_PAGE_TOOL, handleNotionUpdatePage);

  server.registerTool(
    "add_content",
    {
      title: "Add content",
      description:
        "Append Markdown content to a page as blocks (headings, lists, to-dos, quotes, code, etc.).",
      inputSchema: { pageId: z.string(), markdown: z.string().describe("Markdown to append") },
    },
    async ({ pageId, markdown }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before editing.`);
        if (page.isLocked) return ok(lockedPageMessage(page));
        const added = await appendMarkdown(pageId, markdown);
        await eb.update("pages", pageId, pageEditAudit());
        return ok(`Appended ${added} block(s) to "${titleOf(page)}".`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "replace_page_content",
    {
      title: "Replace page content",
      description:
        "Replace all existing blocks in a page with Markdown content. Use get_page first if you need to preserve any current text.",
      inputSchema: {
        pageId: z.string(),
        markdown: z.string().describe("Markdown that should become the full page body"),
      },
    },
    async ({ pageId, markdown }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before editing.`);
        if (page.isLocked) return ok(lockedPageMessage(page));
        const count = await replaceMarkdown(pageId, markdown);
        await eb.update("pages", pageId, pageEditAudit());
        return ok(`Replaced content of "${titleOf(page)}" with ${count} block(s).`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "move_page",
    {
      title: "Move page",
      description:
        "Move a page to the workspace root, under another page, or into a database. Omit parentId for workspace root.",
      inputSchema: {
        pageId: z.string().optional().describe("Page id to move"),
        page_id: z.string().optional().describe("Notion-compatible page id alias"),
        parentId: z.string().optional().describe("Destination parent page/database id; omit for workspace root"),
        parent_id: z.string().optional().describe("Notion-compatible destination parent id alias"),
        parentType: z.enum(PAGE_PARENT_TYPES).optional().describe("Destination type; defaults to page when parentId is set, otherwise workspace"),
        parent_type: z.enum(PAGE_PARENT_TYPES).optional().describe("Notion-compatible destination type alias"),
        afterPageId: z.string().optional().describe("Optional destination sibling to place this page after"),
        after_page_id: z.string().optional().describe("Notion-compatible afterPageId alias"),
        beforePageId: z.string().optional().describe("Optional destination sibling to place this page before"),
        before_page_id: z.string().optional().describe("Notion-compatible beforePageId alias"),
      },
    },
    async ({ pageId, page_id, parentId, parent_id, parentType, parent_type, afterPageId, after_page_id, beforePageId, before_page_id }) => {
      try {
        const targetPageId = stripHanjiId(pageId ?? page_id);
        if (!targetPageId) throw new Error("Provide pageId or page_id.");
        const result = await movePage(targetPageId, {
          parentId: parentId ? stripHanjiId(parentId) : parent_id ? stripHanjiId(parent_id) : undefined,
          parentType: parentType ?? parent_type,
          afterPageId: afterPageId ? stripHanjiId(afterPageId) : after_page_id ? stripHanjiId(after_page_id) : undefined,
          beforePageId: beforePageId ? stripHanjiId(beforePageId) : before_page_id ? stripHanjiId(before_page_id) : undefined,
        });
        if (!result) return ok(`Page ${targetPageId} not found.`);
        const destination =
          result.parentType === "workspace"
            ? "workspace root"
            : `${result.parentType} ${result.parentId}`;
        return ok(`Moved "${titleOf(result.page)}" to ${destination}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["move_pages", "_notion_move_pages"], NOTION_MOVE_PAGES_TOOL, handleNotionMovePages);

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description:
        "List page and block comments for a page. Replies are grouped under their parent comment.",
      inputSchema: {
        pageId: z.string().describe("Page id"),
        includeResolved: z.boolean().optional().describe("Include resolved comments; default false"),
      },
    },
    async ({ pageId, includeResolved = false }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        const [comments, blocks] = await Promise.all([eb.comments(pageId), eb.blocks(pageId)]);
        const blocksById = Object.fromEntries(blocks.map((block) => [block.id, block]));
        const roots = comments
          .filter((comment) => !comment.parentId)
          .filter((comment) => includeResolved || !comment.resolved);
        const repliesByParent = new Map();
        for (const comment of comments) {
          if (!comment.parentId) continue;
          if (!includeResolved && comment.resolved) continue;
          const list = repliesByParent.get(comment.parentId) ?? [];
          list.push(comment);
          repliesByParent.set(comment.parentId, list);
        }
        if (roots.length === 0) {
          return ok(`No ${includeResolved ? "" : "open "}comments on "${titleOf(page)}".`);
        }
        const lines = [`# Comments on ${titleOf(page)}`];
        for (const comment of roots) {
          lines.push(commentLine(comment, { blocksById }));
          for (const reply of repliesByParent.get(comment.id) ?? []) {
            lines.push(commentLine(reply, { blocksById, depth: 1 }));
          }
        }
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    }
  );

  registerToolAliases(["get_comments", "_notion_get_comments"], NOTION_GET_COMMENTS_TOOL, handleNotionGetComments);

  registerToolAliases(["create_comment", "_notion_create_comment"], NOTION_CREATE_COMMENT_TOOL, handleNotionCreateComment);

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description:
        "Add a page comment, a block comment, or a reply to an existing comment.",
      inputSchema: {
        pageId: z.string().describe("Page id"),
        text: z.string().describe("Comment text"),
        blockId: z.string().optional().describe("Optional block id for an anchored block comment"),
        parentId: z.string().optional().describe("Optional parent comment id for a reply"),
        quote: z.string().optional().describe("Optional quoted text for context"),
      },
    },
    async ({ pageId, text, blockId, parentId, quote }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        if (page.inTrash) return ok(`"${titleOf(page)}" is in trash. Restore it before commenting.`);
        const [comments, blocks] = await Promise.all([eb.comments(pageId), eb.blocks(pageId)]);
        const parent = parentId ? comments.find((comment) => comment.id === parentId) : undefined;
        if (parentId && !parent) return ok(`Parent comment ${parentId} not found on page ${pageId}.`);
        if (blockId && !blocks.some((block) => block.id === blockId)) {
          return ok(`Block ${blockId} not found on page ${pageId}.`);
        }
        const cleanText = text.trim();
        if (!cleanText) return ok("Comment text is empty.");
        const cleanQuote = quote?.trim();
        const targetBlockId = blockId ?? parent?.blockId ?? null;
        const comment = await eb.insert("comments", {
          id: eb.newId(),
          pageId,
          blockId: targetBlockId,
          parentId: parentId ?? null,
          authorId: MCP_ACTOR,
          body: cleanQuote ? { rich: [{ text: cleanText }], quote: cleanQuote } : { rich: [{ text: cleanText }] },
          resolved: false,
        });
        return ok(
          `Added ${parentId ? "reply" : targetBlockId ? "block comment" : "page comment"} to "${titleOf(page)}".\ncomment id: ${comment.id}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve comment",
      description: "Resolve or reopen a comment thread.",
      inputSchema: {
        commentId: z.string().describe("Comment id"),
        resolved: z.boolean().optional().describe("Resolved state; default true"),
      },
    },
    async ({ commentId, resolved = true }) => {
      try {
        const comment = await eb.getOne("comments", commentId);
        if (!comment || !comment.id) return ok(`Comment ${commentId} not found.`);
        const comments = await eb.comments(comment.pageId);
        const childrenByParent = new Map();
        for (const item of comments) {
          if (!item.parentId) continue;
          const list = childrenByParent.get(item.parentId) ?? [];
          list.push(item);
          childrenByParent.set(item.parentId, list);
        }
        const idsToUpdate = new Set();
        const collect = (id) => {
          if (idsToUpdate.has(id)) return;
          idsToUpdate.add(id);
          for (const child of childrenByParent.get(id) ?? []) collect(child.id);
        };
        collect(commentId);
        await Promise.all(
          Array.from(idsToUpdate).map((id) =>
            eb.update("comments", id, { resolved }, { pageId: comment.pageId }),
          ),
        );
        return ok(`${resolved ? "Resolved" : "Reopened"} ${idsToUpdate.size} comment(s) in thread ${commentId}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_trash",
    {
      title: "List trash",
      description: "List top-level pages currently in trash. Child pages trashed with a parent are grouped under that parent.",
      inputSchema: {},
    },
    async () => {
      try {
        const pages = await eb.allPages();
        const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
        const trashed = pages
          .filter((page) => page.inTrash)
          .filter((page) => !hasTrashedAncestor(pagesById, page))
          .sort((a, b) => String(b.trashedAt ?? "").localeCompare(String(a.trashedAt ?? "")));
        if (trashed.length === 0) return ok("Trash is empty.");
        return ok(
          trashed
            .map((page) => {
              const childCount = collectPageSubtree(pages, page.id).size - 1;
              return `- ${titleOf(page)}${page.kind === "database" ? " [database]" : ""}${
                childCount > 0 ? ` (${childCount} descendant page(s))` : ""
              }  trashed: ${page.trashedAt ?? "unknown"}  id: ${page.id}`;
            })
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "trash_page",
    {
      title: "Trash page",
      description: "Move a page and its descendant pages to the trash (soft delete).",
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      try {
        const result = await trashPageTree(pageId);
        if (!result) return ok(`Page ${pageId} not found.`);
        return ok(
          `Moved "${titleOf(result.page)}" to trash` +
            `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "restore_page",
    {
      title: "Restore page",
      description:
        "Restore a page from trash. Descendants trashed in the same operation are restored with it.",
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      try {
        const result = await restorePageTree(pageId);
        if (!result) return ok(`Page ${pageId} not found.`);
        if (result.count === 0) return ok(`"${titleOf(result.page)}" is not in trash.`);
        return ok(
          `Restored "${titleOf(result.page)}"` +
            `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_page_forever",
    {
      title: "Delete page forever",
      description:
        "Permanently delete a page subtree already in trash. The trash step is required and this cannot be undone.",
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      try {
        const result = await deletePageTree(pageId);
        if (!result) return ok(`Page ${pageId} not found.`);
        return ok(
          `Deleted "${titleOf(result.page)}" forever` +
            `${result.count > 1 ? ` with ${result.count - 1} descendant page(s)` : ""}.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );
}
