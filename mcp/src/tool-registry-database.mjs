export function registerDatabaseTools(runtime) {
  const {
    DATABASE_PROPERTY_TYPES,
    DATABASE_VIEW_TYPES,
    JsonObjectSchema,
    MCP_ACTOR,
    MCP_DESCRIBE_DATABASE_OUTPUT_SCHEMA,
    MCP_QUERY_DATABASE_OUTPUT_SCHEMA,
    NOTION_UPDATE_VIEW_TOOL,
    NOTION_VIEW_TYPES,
    ROLLUP_FUNCTIONS,
    addPropertyToViews,
    applyDatabaseView,
    assertRequiredNotionViewConfigure,
    blocksToMarkdown,
    clamp,
    clearOtherDefaultTemplates,
    cloneJson,
    collectionUrl,
    countTemplateBlocks,
    databasePropertyRecordFromInput,
    databasePropsContext,
    databaseViewLabel,
    describeDatabaseStructuredContent,
    eb,
    fail,
    formatDbValue,
    handleNotionUpdateView,
    lockedPageMessage,
    markdownToBlocks,
    md,
    normalizeNotionViewConfigureInput,
    notionDataSourceFetchPayload,
    ok,
    okJson,
    okStructured,
    pageEditAudit,
    pageMetadataLines,
    parseNotionDdlStatements,
    persistableDatabaseRowProperties,
    positionBetween,
    propertyByKey,
    propertyConfigForInput,
    propertyConfigPatchForInput,
    queryDataSourceSql,
    queryDataSourceView,
    queryDatabaseStructuredContent,
    registerToolAliases,
    requireMatchingWorkspace,
    requireWorkspaceSelection,
    restorePageTree,
    rowPatchFromProperties,
    schemaLine,
    server,
    stripHanjiId,
    templateBlocksToMarkdown,
    titleOf,
    trashPageTree,
    validateNotionDdlOperations,
    viewByKey,
    viewConfigInputSchema,
    viewConfigPatchForInput,
    viewConfigPatchForNotionInput,
    viewDisplayProperties,
    viewLine,
    z,
  } = runtime;

  server.registerTool(
    "describe_database",
    {
      title: "Describe database",
      description: "Read a database schema: properties, views, and row count.",
      inputSchema: { databaseId: z.string().describe("Database page id") },
      outputSchema: MCP_DESCRIBE_DATABASE_OUTPUT_SCHEMA,
    },
    async ({ databaseId }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") {
          const message = `Database ${databaseId} not found.`;
          return okStructured(message, describeDatabaseStructuredContent(null, [], [], [], message));
        }
        const [props, views, rows] = await Promise.all([
          eb.dbProperties(databaseId),
          eb.dbViews(databaseId),
          eb.dbRows(databaseId),
        ]);
        const propText = props.length ? props.map(schemaLine).join("\n") : "_No properties_";
        const viewText = views.length
          ? views.map((view) => viewLine(view, props)).join("\n")
          : "_No views_";
        return okStructured(
          `# ${titleOf(db)}\n` +
            `database id: ${db.id}\nrows: ${rows.length}\n\n` +
            `## Properties\n${propText}\n\n## Views\n${viewText}`,
          describeDatabaseStructuredContent(db, props, views, rows)
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_database_view",
    {
      title: "Create database view",
      description:
        "Create a saved database view and configure visible properties, filters, grouping, date axes, card display, row opening, and sorts.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        type: z.enum(DATABASE_VIEW_TYPES).describe("View type"),
        name: z.string().optional().describe("View name; defaults to the type label"),
        ...viewConfigInputSchema,
      },
    },
    async ({ databaseId, type, name, ...configInput }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
        const duplicate = views.find((view) => view.name.trim().toLowerCase() === (name ?? databaseViewLabel(type)).trim().toLowerCase());
        if (duplicate) return ok(`View "${duplicate.name}" already exists (id: ${duplicate.id}).`);
        const { config, changed } = viewConfigPatchForInput(props, type, configInput);
        const view = await eb.insert("db_views", {
          id: eb.newId(),
          databaseId,
          name: name?.trim() || databaseViewLabel(type),
          type,
          config,
          position: views.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
        });
        return ok(
          `Created view "${view.name}" [${view.type}] in ${titleOf(db)}.\n` +
            `${viewLine(view, props)}` +
            `${changed.length ? `\nconfigured: ${changed.join(", ")}` : ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "_notion_create_view",
    {
      title: "Create view",
      description:
        "Notion-compatible database view creation for all ten official view types. Exactly one of database_id or parent_page_id is required. parent_page_id appends an inline linked view over data_source_id and therefore crosses both database and page product-permission/policy lanes. The connection is workspace-scoped, so workspace_id is required.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
        teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
        database_id: z.string().optional(),
        parent_page_id: z.string().optional(),
        data_source_id: z.string(),
        name: z.string(),
        type: z.enum(NOTION_VIEW_TYPES),
        configure: z.string().optional().describe("Notion view DSL: FILTER, SORT BY, GROUP BY, CALENDAR BY, TIMELINE BY, MAP BY, CHART, FORM, SHOW, HIDE, COVER, WRAP CELLS, or FREEZE COLUMNS."),
      },
    },
    async ({ workspace_id, teamspace_id, database_id, parent_page_id, data_source_id, name, type, configure }) => {
      try {
        const databaseId = stripHanjiId(data_source_id || database_id);
        if ((database_id ? 1 : 0) + (parent_page_id ? 1 : 0) !== 1) {
          throw new Error("Provide exactly one of database_id or parent_page_id.");
        }
        if (database_id && stripHanjiId(database_id) !== databaseId) {
          throw new Error("database_id must identify the database that owns data_source_id.");
        }
        const normalizedConfigure = normalizeNotionViewConfigureInput(configure);
        assertRequiredNotionViewConfigure(type, normalizedConfigure);
        const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_create_view");
        if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Data source ${data_source_id} not found.`);
        const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_create_view", "Data source");
        if (matched.errorResult) return matched.errorResult;
        if (db.isLocked) return ok(lockedPageMessage(db));
        // Validate the destination parent BEFORE inserting the view so a bad
        // parent_page_id cannot leave an orphaned view behind.
        let parent = null;
        if (parent_page_id) {
          const parentPageId = stripHanjiId(parent_page_id);
          parent = await eb.getOne("pages", parentPageId);
          if (!parent || parent.kind !== "page") throw new Error(`Parent page ${parent_page_id} not found.`);
          const parentMatched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, parent, "_notion_create_view", "Parent page");
          if (parentMatched.errorResult) return parentMatched.errorResult;
        }

        const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
        const duplicate = views.find((view) => view.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (duplicate) return ok(`View "${duplicate.name}" already exists (id: ${duplicate.id}).`);
        const { config } = viewConfigPatchForNotionInput(props, type, normalizedConfigure);
        const view = await eb.insert("db_views", {
          id: eb.newId(),
          databaseId,
          name: name.trim() || databaseViewLabel(type),
          type,
          config,
          position: views.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
        });

        let blockId = null;
        if (parent) {
          try {
            const rootBlocks = (await eb.blocks(parent.id)).filter((block) => !block.parentId);
            const position = positionBetween(rootBlocks.reduce((max, block) => Math.max(max, block.position ?? 0), 0), undefined);
            const block = await eb.insert("blocks", {
              id: eb.newId(),
              pageId: parent.id,
              parentId: null,
              type: "inline_database",
              content: {
                childPageId: databaseId,
                childPageTitle: db.title || "Untitled",
                childPageKind: "database",
                databaseViewId: view.id,
                databaseViewIds: [view.id],
                linkedDatabaseSource: true,
                rich: [{ text: db.title || "Untitled" }],
              },
              plainText: db.title || "Untitled",
              position,
              createdBy: MCP_ACTOR,
            });
            blockId = block.id;
          } catch (error) {
            // Roll back the freshly created view (insertTemplateBlocks pattern)
            // so a failed embed does not orphan it.
            await eb.del("db_views", view.id, { databaseId }).catch(() => {});
            throw error;
          }
        }

        return okJson({
          id: view.id,
          name: view.name,
          type: view.type,
          data_source_url: collectionUrl(databaseId),
          block_id: blockId,
        });
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_database_view",
    {
      title: "Update database view",
      description:
        "Update a saved database view's name, type, visible properties, filters, grouping, date axes, card display, row opening, and sorts.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        view: z.string().describe("View name or id"),
        name: z.string().optional().describe("New view name"),
        type: z.enum(DATABASE_VIEW_TYPES).optional().describe("New view type"),
        ...viewConfigInputSchema,
      },
    },
    async ({ databaseId, view: viewKey, name, type, ...configInput }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const [props, views] = await Promise.all([eb.dbProperties(databaseId), eb.dbViews(databaseId)]);
        const view = viewByKey(views, viewKey);
        if (!view) return ok(`View "${viewKey}" not found in ${titleOf(db)}.`);

        const patch = {};
        const changed = [];
        if (name !== undefined) {
          const trimmed = name.trim();
          if (!trimmed) return ok("View name cannot be empty.");
          const duplicate = views.find(
            (item) => item.id !== view.id && item.name.trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (duplicate) return ok(`View "${trimmed}" already exists (id: ${duplicate.id}).`);
          patch.name = trimmed;
          changed.push("name");
        }
        if (type !== undefined && type !== view.type) {
          patch.type = type;
          changed.push("type");
        }

        const nextType = type ?? view.type;
        const { config, changed: configChanged } = viewConfigPatchForInput(props, nextType, configInput, view.config);
        if (configChanged.length || type !== undefined) {
          patch.config = config;
          changed.push(...configChanged);
        }

        if (Object.keys(patch).length === 0) return ok(`No changes supplied for view "${view.name}".`);
        const updated = await eb.update("db_views", view.id, patch, { databaseId });
        return ok(
          `Updated view "${updated.name}" in ${titleOf(db)}.\n` +
            `${viewLine(updated, props)}\n` +
            `changed: ${Array.from(new Set(changed)).join(", ")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_view",
    {
      ...NOTION_UPDATE_VIEW_TOOL,
      description:
        "Hanji-compatible extended view update. In addition to the official name/configure shape, this legacy alias accepts database hints, type changes, object configure, and direct view configuration fields.",
      inputSchema: {
        ...NOTION_UPDATE_VIEW_TOOL.inputSchema,
        database_id: z.string().optional(),
        data_source_id: z.string().optional(),
        data_source_url: z.string().optional(),
        type: z.enum(DATABASE_VIEW_TYPES).optional(),
        configure: z.union([z.string(), JsonObjectSchema]).optional(),
        ...viewConfigInputSchema,
      },
    },
    handleNotionUpdateView
  );
  registerToolAliases(["_notion_update_view"], NOTION_UPDATE_VIEW_TOOL, handleNotionUpdateView);

  server.registerTool(
    "delete_database_view",
    {
      title: "Delete database view",
      description: "Delete a saved database view. The final remaining view is protected.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        view: z.string().describe("View name or id"),
      },
    },
    async ({ databaseId, view: viewKey }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const views = await eb.dbViews(databaseId);
        const view = viewByKey(views, viewKey);
        if (!view) return ok(`View "${viewKey}" not found in ${titleOf(db)}.`);
        if (views.length <= 1) return ok(`Cannot delete the only view in ${titleOf(db)}.`);
        await eb.del("db_views", view.id, { databaseId });
        return ok(`Deleted view "${view.name}" from ${titleOf(db)}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "list_database_templates",
    {
      title: "List database templates",
      description: "List page templates configured for a database.",
      inputSchema: { databaseId: z.string().describe("Database page id") },
    },
    async ({ databaseId }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        const templates = await eb.dbTemplates(databaseId);
        if (templates.length === 0) return ok(`No templates found in ${titleOf(db)}.`);
        return ok(
          templates
            .map((template) => {
              const blockCount = countTemplateBlocks(template.blocks);
              const title = template.title ? ` title: ${template.title}` : "";
              return `- ${template.icon ?? ""} ${template.name || "Untitled template"}${
                template.isDefault ? " [default]" : ""
              }${
                title ? ` (${title.trim()})` : ""
              }  id: ${template.id}  blocks: ${blockCount}`;
            })
            .join("\n")
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "create_database_template",
    {
      title: "Create database template",
      description:
        "Create a database row/page template. Properties can be keyed by property name or id, and content is Markdown.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        name: z.string().describe("Template name"),
        title: z.string().optional().describe("Default row title / Name property"),
        icon: z.string().optional().describe("Optional emoji icon"),
        isDefault: z.boolean().optional().describe("Use this template when creating rows without a template id"),
        properties: JsonObjectSchema.optional().describe("Default property values keyed by property name or id"),
        content: z.string().optional().describe("Default page body as Markdown"),
      },
    },
    async ({ databaseId, name, title, icon, isDefault, properties, content }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const [props, templates] = await Promise.all([eb.dbProperties(databaseId), eb.dbTemplates(databaseId)]);
        const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
        const blocks = content ? markdownToBlocks(content) : [{ type: "paragraph", content: { rich: [] } }];
        const template = await eb.insert("db_templates", {
          id: eb.newId(),
          databaseId,
          name,
          icon,
          title: title ?? patch.title ?? "",
          properties: patch.properties,
          blocks,
          isDefault: !!isDefault,
          position: templates.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
        });
        if (isDefault) {
          await Promise.all(
            templates
              .filter((item) => item.isDefault)
              .map((item) =>
                eb.update("db_templates", item.id, { isDefault: false }, { databaseId: item.databaseId ?? databaseId })
              )
          );
        }
        const notes = [
          template.isDefault ? "Set as default template" : "",
          unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
          readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
        ].filter(Boolean);
        return ok(
          `Created template "${template.name || "Untitled template"}" in ${titleOf(db)}.\n` +
            `template id: ${template.id}` +
            `${notes.length ? `\n${notes.join("\n")}` : ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_database_template",
    {
      title: "Get database template",
      description: "Read a database template's metadata, default properties, and Markdown body.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        templateId: z.string().describe("Database template id"),
      },
    },
    async ({ databaseId, templateId }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        const [props, templates, pages] = await Promise.all([
          eb.dbProperties(databaseId),
          eb.dbTemplates(databaseId),
          eb.pages(),
        ]);
        const template = templates.find((item) => item.id === templateId);
        if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
        const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
        const propLines = props
          .filter((prop) => prop.type !== "title" && template.properties?.[prop.id] != null)
          .map((prop) => `- ${prop.name}: ${formatDbValue({ properties: template.properties }, prop, pagesById, props)}`);
        const body = templateBlocksToMarkdown(template.blocks);
        return ok(
          `# ${template.icon ?? ""} ${template.name || "Untitled template"}\n` +
            `template id: ${template.id}\n` +
            `database: ${titleOf(db)} (${db.id})\n` +
            `default: ${template.isDefault ? "yes" : "no"}\n` +
            `default title: ${template.title || ""}\n\n` +
            `## Properties\n${propLines.length ? propLines.join("\n") : "_No default properties_"}\n\n` +
            `## Content\n${body || "_(empty template)_"}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_database_template",
    {
      title: "Update database template",
      description:
        "Update a database template's metadata, default properties, or Markdown body. Omitted fields are left unchanged.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        templateId: z.string().describe("Database template id"),
        name: z.string().optional().describe("Template name"),
        title: z.string().optional().describe("Default row title / Name property"),
        icon: z.string().optional().describe("Emoji icon. Pass an empty string to clear."),
        isDefault: z.boolean().optional().describe("Whether this is the default template for new rows"),
        properties: JsonObjectSchema.optional().describe("Properties to merge into template defaults"),
        replaceProperties: z.boolean().optional().describe("Replace all editable defaults instead of merging"),
        content: z.string().optional().describe("Replace the template body with Markdown"),
      },
    },
    async ({ databaseId, templateId, name, title, icon, isDefault, properties, replaceProperties, content }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const [props, templates] = await Promise.all([eb.dbProperties(databaseId), eb.dbTemplates(databaseId)]);
        const template = templates.find((item) => item.id === templateId);
        if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);

        const update = {};
        if (name !== undefined) update.name = name;
        if (title !== undefined) update.title = title;
        if (icon !== undefined) update.icon = icon || null;
        if (isDefault !== undefined) update.isDefault = isDefault;
        if (content !== undefined) update.blocks = markdownToBlocks(content);

        const notes = [];
        if (properties !== undefined) {
          const { patch, unknown, readonly } = rowPatchFromProperties(props, properties);
          update.properties = replaceProperties
            ? patch.properties
            : { ...(template.properties ?? {}), ...(patch.properties ?? {}) };
          if (patch.title !== undefined && title === undefined) update.title = patch.title;
          if (unknown.length) notes.push(`Ignored unknown properties: ${unknown.join(", ")}`);
          if (readonly.length) notes.push(`Skipped read-only properties: ${readonly.join(", ")}`);
        }

        if (Object.keys(update).length === 0) return ok(`No changes supplied for template ${templateId}.`);
        const updated = await eb.update("db_templates", template.id, update, { databaseId });
        if (isDefault) await clearOtherDefaultTemplates(databaseId, template.id);
        return ok(
          `Updated template "${updated.name || "Untitled template"}" in ${titleOf(db)}.\n` +
            `template id: ${template.id}${notes.length ? `\n${notes.join("\n")}` : ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "duplicate_database_template",
    {
      title: "Duplicate database template",
      description: "Duplicate an existing database template, including default properties and Markdown body.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        templateId: z.string().describe("Template id to duplicate"),
        name: z.string().optional().describe("Optional name for the duplicated template"),
        isDefault: z.boolean().optional().describe("Make the duplicate the default template"),
      },
    },
    async ({ databaseId, templateId, name, isDefault }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const templates = await eb.dbTemplates(databaseId);
        const source = templates.find((item) => item.id === templateId);
        if (!source) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
        const duplicate = await eb.insert("db_templates", {
          id: eb.newId(),
          databaseId,
          name: name ?? `${source.name || "Untitled template"} copy`,
          icon: source.icon,
          title: source.title ?? "",
          properties: cloneJson(source.properties ?? {}),
          blocks: cloneJson(source.blocks ?? [{ type: "paragraph", content: { rich: [] } }]),
          isDefault: !!isDefault,
          position: templates.reduce((max, item) => Math.max(max, item.position ?? 0), 0) + 1,
        });
        if (isDefault) await clearOtherDefaultTemplates(databaseId, duplicate.id);
        return ok(
          `Duplicated template "${source.name || "Untitled template"}" as "${
            duplicate.name || "Untitled template"
          }" in ${titleOf(db)}.\n` +
            `template id: ${duplicate.id}` +
            `${duplicate.isDefault ? "\nSet as default template" : ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_database_template",
    {
      title: "Delete database template",
      description: "Delete a database template. Existing rows created from it are not changed.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        templateId: z.string().describe("Database template id"),
      },
    },
    async ({ databaseId, templateId }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const template = (await eb.dbTemplates(databaseId)).find((item) => item.id === templateId);
        if (!template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
        await eb.del("db_templates", template.id, { databaseId });
        return ok(`Deleted template "${template.name || "Untitled template"}" from ${titleOf(db)}.`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "query_database",
    {
      title: "Query database",
      description:
        "Read database rows as a Markdown table. Optionally apply a saved view's visible properties, filters, and sorts.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        view: z.string().optional().describe("Optional saved view name or id to apply"),
        limit: z.number().int().min(1).max(100).optional().describe("Rows to return, default 25"),
        search: z.string().optional().describe("Optional case-insensitive search over row title and displayed properties"),
      },
      outputSchema: MCP_QUERY_DATABASE_OUTPUT_SCHEMA,
    },
    async ({ databaseId, view: viewKey, limit = 25, search }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        const safeLimit = clamp(limit, 1, 100);
        if (!db || db.kind !== "database") {
          const message = `Database ${databaseId} not found.`;
          return okStructured(
            message,
            queryDatabaseStructuredContent({ database: null, limit: safeLimit, search, message })
          );
        }
        const [props, rows, pages, views] = await Promise.all([
          eb.dbProperties(databaseId),
          eb.dbRows(databaseId, { includeComputed: true }),
          eb.pages(),
          eb.dbViews(databaseId),
        ]);
        const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
        const propsByDb = await databasePropsContext(pages, databaseId, props);
        const selectedView = viewKey ? viewByKey(views, viewKey) : undefined;
        if (viewKey && !selectedView) {
          const message = `View "${viewKey}" not found in ${titleOf(db)}.`;
          return okStructured(
            message,
            queryDatabaseStructuredContent({ database: db, limit: safeLimit, search, message })
          );
        }
        const visibleProps = props.length
          ? viewDisplayProperties(props, selectedView)
          : [{ id: "__title", name: "Name", type: "title" }];
        const filtered = applyDatabaseView(rows, props, pagesById, selectedView, search, propsByDb);
        const selected = filtered.slice(0, safeLimit);
        if (selected.length === 0) {
          const message = `No rows found in ${titleOf(db)}.`;
          return okStructured(
            message,
            queryDatabaseStructuredContent({
              database: db,
              view: selectedView,
              visibleProps,
              rows: selected,
              totalMatching: filtered.length,
              limit: safeLimit,
              search,
              pagesById,
              props,
              propsByDb,
              message,
            })
          );
        }
        const headers = ["row id", ...visibleProps.map((prop) => prop.name)];
        const lines = [
          `# ${titleOf(db)}`,
          ...(selectedView ? [`view: ${selectedView.name} [${selectedView.type}]`] : []),
          `Showing ${selected.length} of ${filtered.length} matching row(s).`,
          "",
          `| ${headers.map(md).join(" | ")} |`,
          `| ${headers.map(() => "---").join(" | ")} |`,
          ...selected.map((row) =>
            `| ${[row.id, ...visibleProps.map((prop) => formatDbValue(row, prop, pagesById, props, propsByDb))]
              .map(md)
              .join(" | ")} |`
          ),
        ];
        return okStructured(
          lines.join("\n"),
          queryDatabaseStructuredContent({
            database: db,
            view: selectedView,
            visibleProps,
            rows: selected,
            totalMatching: filtered.length,
            limit: safeLimit,
            search,
            pagesById,
            props,
            propsByDb,
          })
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "_notion_query_data_sources",
    {
      title: "Query data sources",
      description:
        "Notion-compatible data source query. The connection is workspace-scoped, so data.workspace_id is required. SQL mode streams one collection:// source with bind-safe filters, projections, direct-property multi-key ordering, LIMIT/OFFSET, and opaque continuation; cross-window joins, CTEs/subqueries, DISTINCT, grouping/aggregates, unions, and computed ordering fail before row reads. View mode queries saved Hanji database views.",
      inputSchema: {
        data: z.union([
          z.object({
            workspace_id: z.string().optional(),
            teamspace_id: z.string().optional(),
            mode: z.literal("sql").optional(),
            data_source_urls: z.array(z.string()).min(1).max(10),
            query: z.string(),
            params: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(256).optional(),
            start_cursor: z.string().optional(),
          }).strict(),
          z.object({
            workspace_id: z.string().optional(),
            teamspace_id: z.string().optional(),
            mode: z.literal("view"),
            view_url: z.string(),
            is_archived: z.boolean().optional(),
            page_size: z.number().min(1).max(100).optional(),
            start_cursor: z.string().optional(),
          }).strict(),
        ]),
      },
    },
    async ({ data }) => {
      try {
        const input = data && typeof data === "object" && !Array.isArray(data) ? data : {};
        const result = input.mode === "view" ? await queryDataSourceView(input) : await queryDataSourceSql(input);
        if (result?.__workspaceErrorResult) return result.__workspaceErrorResult;
        return okJson(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "add_database_row",
    {
      title: "Add database row",
      description:
        "Create a row in a database. Properties can be keyed by property name or id. Select/status values may use option names.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        title: z.string().optional().describe("Row title / Name property"),
        templateId: z.string().optional().describe("Optional database template id to apply"),
        empty: z.boolean().optional().describe("Skip the database default template"),
        properties: JsonObjectSchema.optional().describe("Property values keyed by property name or id"),
      },
    },
    async ({ databaseId, title, templateId, empty, properties }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const [props, templates] = await Promise.all([
          eb.dbProperties(databaseId),
          eb.dbTemplates(databaseId),
        ]);
        const template = templateId
          ? templates.find((item) => item.id === templateId)
          : empty
            ? undefined
            : templates.find((item) => item.isDefault);
        if (templateId && !template) return ok(`Template ${templateId} not found in ${titleOf(db)}.`);
        const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
        const result = await eb.createDatabaseRow({
          id: eb.newId(),
          databaseId,
          templateId: templateId ?? undefined,
          empty: !!empty,
          title: patch.title ?? title,
          properties: patch.properties ?? {},
        });
        const row = result.row;
        const blockCount = result.blocks?.length ?? 0;
        const notes = [
          template ? `Applied template: ${template.name || template.id}` : "",
          blockCount ? `Added ${blockCount} template block(s)` : "",
          unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
          readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
        ].filter(Boolean);
        return ok(
          `Created row "${row.title || "Untitled"}" in ${titleOf(db)}.\nrow id: ${row.id}${
            notes.length ? `\n${notes.join("\n")}` : ""
          }`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_database_row",
    {
      title: "Update database row",
      description:
        "Update a database row by row id. Properties can be keyed by property name or id. Only supplied properties are changed.",
      inputSchema: {
        rowId: z.string().describe("Database row page id"),
        title: z.string().optional().describe("New row title / Name property"),
        properties: JsonObjectSchema.optional().describe("Property values keyed by property name or id"),
      },
    },
    async ({ rowId, title, properties }) => {
      try {
        const row = await eb.getOne("pages", rowId);
        if (!row || row.parentType !== "database" || !row.parentId) {
          return ok(`Database row ${rowId} not found.`);
        }
        if (row.isLocked) return ok(lockedPageMessage(row));
        const db = await eb.getOne("pages", row.parentId);
        if (!db || db.kind !== "database") return ok(`Database ${row.parentId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const props = await eb.dbProperties(row.parentId);
        const { patch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
        if (title !== undefined) patch.title = title;
        const nextProperties = persistableDatabaseRowProperties({
          ...(row.properties ?? {}),
          ...(patch.properties ?? {}),
        });
        const update = {};
        if (patch.title !== undefined) update.title = patch.title;
        if (Object.keys(patch.properties ?? {}).length > 0) update.properties = nextProperties;
        if (Object.keys(update).length === 0) {
          return ok(`No editable changes supplied for row ${rowId}.`);
        }
        const updated = await eb.updateDatabaseRow(rowId, { ...update, ...pageEditAudit() });
        const notes = [
          unknown.length ? `Ignored unknown properties: ${unknown.join(", ")}` : "",
          readonly.length ? `Skipped read-only properties: ${readonly.join(", ")}` : "",
        ].filter(Boolean);
        return ok(
          `Updated row "${updated.title || "Untitled"}" (id: ${rowId}).${
            notes.length ? `\n${notes.join("\n")}` : ""
          }`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "move_database_row",
    {
      title: "Move database row",
      description:
        "Move a database row before or after another row in the same database through the backend product API.",
      inputSchema: {
        rowId: z.string().describe("Database row page id to move"),
        targetRowId: z.string().describe("Sibling database row id to move before/after"),
        side: z.enum(["before", "after"]).optional().describe("Where to place the row relative to targetRowId"),
      },
    },
    async ({ rowId, targetRowId, side = "after" }) => {
      try {
        const result = await eb.moveDatabaseRow(rowId, targetRowId, side);
        const row = result.row ?? {};
        const target = result.target ?? {};
        return ok(
          `Moved row "${row.title || "Untitled"}" (id: ${row.id || rowId}) ${side} ` +
            `"${target.title || "Untitled"}" (id: ${target.id || targetRowId}).\n` +
            `position: ${result.position ?? row.position ?? ""}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "trash_database_row",
    {
      title: "Trash database row",
      description: "Move a database row to trash (soft delete).",
      inputSchema: { rowId: z.string().describe("Database row page id") },
    },
    async ({ rowId }) => {
      try {
        const row = await eb.getOne("pages", rowId);
        if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
        const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
        if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const result = await trashPageTree(rowId);
        return ok(
          `Moved row "${row.title || "Untitled"}" (id: ${rowId}) to trash` +
            `${result?.count && result.count > 1 ? ` with ${result.count - 1} child page(s)` : ""}.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "restore_database_row",
    {
      title: "Restore database row",
      description: "Restore a trashed database row and its row-page subtree.",
      inputSchema: { rowId: z.string().describe("Database row page id") },
    },
    async ({ rowId }) => {
      try {
        const row = await eb.getOne("pages", rowId);
        if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
        const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
        if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const result = await restorePageTree(rowId);
        return ok(
          `Restored row "${row.title || "Untitled"}" (id: ${rowId})` +
            `${result?.count && result.count > 1 ? ` with ${result.count - 1} child page(s)` : ""}.`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_database_row_forever",
    {
      title: "Delete database row forever",
      description:
        "Permanently delete a database row already in trash and clean its row-page subtree, including child pages, blocks, comments, collaboration logs, notifications, and files.",
      inputSchema: { rowId: z.string().describe("Database row page id") },
    },
    async ({ rowId }) => {
      try {
        const row = await eb.getOne("pages", rowId);
        if (!row || row.parentType !== "database") return ok(`Database row ${rowId} not found.`);
        if (!row.inTrash) {
          throw new Error(`Database row ${rowId} must be moved to trash before permanent deletion.`);
        }
        const db = row.parentId ? await eb.getOne("pages", row.parentId) : null;
        if (!db || db.kind !== "database") return ok(`Database ${row.parentId ?? ""} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const result = await eb.deleteDatabaseRow(rowId, {
          databaseId: row.parentId,
          workspaceId: row.workspaceId,
        });
        const cleanup = result.cleanup ?? {};
        return ok(
          `Deleted row "${row.title || "Untitled"}" (id: ${rowId}) forever.\n` +
            `deleted pages: ${result.deletedIds?.length ?? 1}\n` +
            `cleaned blocks: ${cleanup.blocks ?? 0}\n` +
            `cleaned comments: ${cleanup.comments ?? 0}\n` +
            `cleaned collaboration logs: ${cleanup.collaborationOperations ?? 0}\n` +
            `cleaned files: ${cleanup.fileUploads ?? 0}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "add_database_property",
    {
      title: "Add database property",
      description:
        "Add a property to a database schema. For select/status/multi-select, pass option names in options.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        name: z.string().describe("Property name"),
        type: z.enum(DATABASE_PROPERTY_TYPES).describe("Property type"),
        options: z.array(z.string()).optional().describe("Option names for select, status, or multi-select"),
        numberFormat: z.enum(["number", "comma", "percent", "dollar", "won", "euro"]).optional(),
        idPrefix: z.string().optional().describe("Display prefix for ID properties, e.g. TASK"),
        relationDatabaseId: z.string().optional().describe("Related database id for relation properties"),
        twoWay: z.boolean().optional().describe("For relation properties: create a Notion-style two-way relation. The backend creates and cross-links a reciprocal relation property on the related database. Defaults to one-way."),
        formula: z.string().optional().describe("Formula expression for formula properties"),
        rollupRelationPropertyId: z.string().optional(),
        rollupTargetPropertyId: z.string().optional(),
        rollupFunction: z.enum(ROLLUP_FUNCTIONS).optional(),
        hideWhenEmpty: z.boolean().optional().describe("Hide this property in row/page panels when its value is empty"),
        hideInPagePanel: z.boolean().optional().describe("Always hide this property in row/page panels until hidden properties are expanded"),
      },
    },
    async ({ databaseId, name, type, ...configInput }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const existing = await eb.dbProperties(databaseId);
        const duplicate = existing.find((prop) => prop.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (duplicate) return ok(`Property "${name}" already exists (id: ${duplicate.id}).`);
        const id = eb.newId();
        const position = existing.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1;
        const config = propertyConfigForInput(type, configInput, databaseId);
        await eb.insert("db_properties", {
          id,
          databaseId,
          name,
          type,
          config,
          position,
        });
        const updatedViews = await addPropertyToViews(databaseId, id);
        return ok(
          `Added property "${name}" [${type}] to ${titleOf(db)}.\nproperty id: ${id}${
            updatedViews.length ? `\nAdded to views: ${updatedViews.join(", ")}` : ""
          }`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "update_database_property",
    {
      title: "Update database property",
      description:
        "Update a database property's name, description, options, formatting, relation/formula/rollup config, or row-page display settings.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        property: z.string().describe("Property name or id"),
        name: z.string().optional().describe("New property name"),
        description: z.string().optional().describe("Property description. Pass an empty string to clear."),
        options: z.array(z.string()).optional().describe("Replace option names for select, status, or multi-select. Existing options keep ids when names match."),
        numberFormat: z.enum(["number", "comma", "percent", "dollar", "won", "euro"]).optional(),
        idPrefix: z.string().optional().describe("Display prefix for ID properties, e.g. TASK. Pass an empty string to clear."),
        relationDatabaseId: z.string().optional().describe("Related database id for relation properties"),
        twoWay: z.boolean().optional().describe("For relation properties: enable a Notion-style two-way relation by creating a cross-linked reciprocal property on the related database. Only enabling is supported here; to remove a two-way relation, delete the paired property."),
        formula: z.string().optional().describe("Formula expression for formula properties"),
        rollupRelationPropertyId: z.string().optional(),
        rollupTargetPropertyId: z.string().optional(),
        rollupFunction: z.enum(ROLLUP_FUNCTIONS).optional(),
        hideWhenEmpty: z.boolean().optional().describe("Hide this property in row/page panels when its value is empty"),
        hideInPagePanel: z.boolean().optional().describe("Always hide this property in row/page panels until hidden properties are expanded"),
      },
    },
    async ({ databaseId, property, name, description, ...configInput }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const props = await eb.dbProperties(databaseId);
        const prop = propertyByKey(props, property);
        if (!prop) return ok(`Property "${property}" not found in ${titleOf(db)}.`);

        const patch = {};
        const changedFields = [];
        if (name !== undefined) {
          const trimmed = name.trim();
          if (!trimmed) return ok("Property name cannot be empty.");
          const duplicate = props.find(
            (item) => item.id !== prop.id && item.name.trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (duplicate) return ok(`Property "${trimmed}" already exists (id: ${duplicate.id}).`);
          patch.name = trimmed;
          changedFields.push("name");
        }
        if (description !== undefined) {
          patch.description = description || null;
          changedFields.push("description");
        }

        const { config, changed } = propertyConfigPatchForInput(prop, configInput);
        if (changed.length) {
          patch.config = config;
          changedFields.push(...changed);
        }

        if (Object.keys(patch).length === 0) return ok(`No changes supplied for property "${prop.name}".`);
        const updated = await eb.update("db_properties", prop.id, patch, { databaseId });
        return ok(
          `Updated property "${updated.name}" in ${titleOf(db)}.\n` +
            `${schemaLine(updated)}\n` +
            `changed: ${Array.from(new Set(changedFields)).join(", ")}`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "delete_database_property",
    {
      title: "Delete database property",
      description:
        "Delete a non-title database property and remove its values from rows, templates, and view settings.",
      inputSchema: {
        databaseId: z.string().describe("Database page id"),
        property: z.string().describe("Property name or id"),
      },
    },
    async ({ databaseId, property }) => {
      try {
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Database ${databaseId} not found.`);
        if (db.isLocked) return ok(lockedPageMessage(db));
        const props = await eb.dbProperties(databaseId);
        const prop = propertyByKey(props, property);
        if (!prop) return ok(`Property "${property}" not found in ${titleOf(db)}.`);
        if (prop.type === "title") return ok("The title property cannot be deleted.");

        const result = await eb.del("db_properties", prop.id, { databaseId });
        const cleanup = result?.cleanup ?? {};

        return ok(
          `Deleted property "${prop.name}" from ${titleOf(db)}.\n` +
            `Cleaned ${cleanup.rows ?? 0} row value(s), ${cleanup.views ?? 0} view setting(s), ` +
            `${cleanup.templates ?? 0} template value(s), ${cleanup.properties ?? 0} dependent property config(s).`
        );
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "_notion_update_data_source",
    {
      title: "Update data source",
      description:
        "Notion-compatible data source schema/title/trash update. The connection is workspace-scoped, so workspace_id is required. Supports ADD/DROP/RENAME/ALTER COLUMN DDL for Hanji database properties.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Required Hanji workspace id. Call list_workspaces or _notion_get_teams first and choose one; calls without it return a workspace selection error."),
        teamspace_id: z.string().optional().describe("Notion-compatible alias for workspace_id. In Hanji this must be a Hanji workspace id."),
        data_source_id: z.string().describe("collection:// URI, data source id, or single-source database id"),
        title: z.string().optional(),
        description: z.string().optional(),
        is_inline: z.boolean().optional(),
        in_trash: z.boolean().optional(),
        statements: z.string().optional().describe("Semicolon-separated DDL statements"),
      },
    },
    async ({ workspace_id, teamspace_id, data_source_id, title, description, is_inline, in_trash, statements }) => {
      try {
        const requiredWorkspace = await requireWorkspaceSelection({ workspace_id, teamspace_id }, "_notion_update_data_source");
        if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
        const databaseId = stripHanjiId(data_source_id);
        const db = await eb.getOne("pages", databaseId);
        if (!db || db.kind !== "database") return ok(`Data source ${data_source_id} not found.`);
        const matched = await requireMatchingWorkspace({ workspace_id: requiredWorkspace.workspaceId }, db, "_notion_update_data_source", "Data source");
        if (matched.errorResult) return matched.errorResult;
        if (db.isLocked && in_trash !== true) return ok(lockedPageMessage(db));
        const notes = [];
        const ddlOps = statements?.trim() ? parseNotionDdlStatements(statements) : [];
        if (is_inline !== undefined) {
          const parentDatabaseId = db.properties?.notionParentDatabaseId ?? db.id;
          if (parentDatabaseId !== db.id) throw new Error("is_inline is only supported for single-source databases.");
        }
        const pagePatch = {
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined || is_inline !== undefined
            ? {
                properties: {
                  ...(db.properties ?? {}),
                  ...(description !== undefined ? { notionDescription: description } : {}),
                  ...(is_inline !== undefined ? { notionIsInline: is_inline } : {}),
                },
              }
            : {}),
        };
        if (Object.keys(pagePatch).length) await eb.update("pages", databaseId, { ...pagePatch, ...pageEditAudit() });
        if (in_trash === true) {
          await trashPageTree(databaseId);
        } else if (in_trash === false) {
          await restorePageTree(databaseId);
        }

        if (ddlOps.length) {
          const ops = ddlOps;
          let props = await eb.dbProperties(databaseId);
          validateNotionDdlOperations(props, ops);
          for (const op of ops) {
            if (op.action === "add") {
              if (op.property.type === "title") throw new Error("Cannot add a second title property.");
              const duplicate = propertyByKey(props, op.property.name);
              if (duplicate) throw new Error(`Property "${op.property.name}" already exists.`);
              const record = databasePropertyRecordFromInput(
                databaseId,
                op.property,
                props.reduce((max, prop) => Math.max(max, prop.position ?? 0), 0) + 1
              );
              await eb.insert("db_properties", record);
              if (op.property.twoWay && op.property.reciprocalName && record.config?.relatedPropertyId) {
                await eb.update(
                  "db_properties",
                  record.config.relatedPropertyId,
                  { name: op.property.reciprocalName },
                  { databaseId: record.config.relationDatabaseId }
                );
              }
              await addPropertyToViews(databaseId, record.id);
              props = await eb.dbProperties(databaseId);
              continue;
            }
            if (op.action === "drop") {
              const prop = propertyByKey(props, op.name);
              if (!prop) throw new Error(`Property "${op.name}" not found.`);
              if (prop.type === "title") throw new Error("Cannot delete the title property.");
              await eb.del("db_properties", prop.id, { databaseId });
              props = await eb.dbProperties(databaseId);
              continue;
            }
            if (op.action === "rename") {
              const prop = propertyByKey(props, op.from);
              if (!prop) throw new Error(`Property "${op.from}" not found.`);
              await eb.update("db_properties", prop.id, { name: op.to }, { databaseId });
              props = await eb.dbProperties(databaseId);
              continue;
            }
            if (op.action === "alter") {
              const prop = propertyByKey(props, op.name);
              if (!prop) throw new Error(`Property "${op.name}" not found.`);
              if (prop.type === "title" || op.property.type === "title") throw new Error("Cannot alter title property type.");
              const nextConfig = propertyConfigForInput(op.property.type ?? prop.type, op.property, databaseId);
              await eb.update(
                "db_properties",
                prop.id,
                {
                  type: op.property.type ?? prop.type,
                  description: op.property.description ?? prop.description ?? null,
                  config: nextConfig,
                },
                { databaseId }
              );
              if (op.property.twoWay && op.property.reciprocalName) {
                const relatedPropertyId = nextConfig?.relatedPropertyId;
                if (relatedPropertyId) {
                  await eb.update(
                    "db_properties",
                    relatedPropertyId,
                    { name: op.property.reciprocalName },
                    { databaseId: op.property.relationDatabaseId ?? databaseId }
                  );
                }
              }
              props = await eb.dbProperties(databaseId);
            }
          }
        }

        const updated = await eb.getOne("pages", databaseId);
        const payload = await notionDataSourceFetchPayload(updated ?? db);
        return ok(`${payload.text}${notes.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : ""}`);
      } catch (e) {
        return fail(e);
      }
    }
  );

  server.registerTool(
    "get_page",
    {
      title: "Get page",
      description: "Read a page's content as Markdown, including its title and metadata.",
      inputSchema: { pageId: z.string() },
    },
    async ({ pageId }) => {
      try {
        const page = await eb.getOne("pages", pageId);
        if (!page || !page.id) return ok(`Page ${pageId} not found.`);
        const blocks = await eb.blocks(pageId);
        const body = blocksToMarkdown(blocks);
        const header = `# ${titleOf(page)}\n\n## Metadata\n${pageMetadataLines(page).join("\n")}\n`;
        return ok(header + "\n## Content\n" + (body || "_(empty page)_"));
      } catch (e) {
        return fail(e);
      }
    }
  );
}
