// Official Notion MCP names are aliases over the same product-backed handlers
// as Hanji's historical names. Keeping that policy here prevents the MCP
// orchestration entrypoint and individual registries from drifting apart.
const OFFICIAL_NOTION_ALIASES = new Map([
  ["_search", ["notion-search"]],
  ["_fetch", ["notion-fetch"]],
  ["_notion_create_pages", ["notion-create-pages"]],
  ["_notion_update_page", ["notion-update-page"]],
  ["_notion_move_pages", ["notion-move-pages"]],
  ["_notion_duplicate_page", ["notion-duplicate-page"]],
  ["_notion_create_database", ["notion-create-database"]],
  ["_notion_update_data_source", ["notion-update-data-source"]],
  ["_notion_create_view", ["notion-create-view"]],
  ["_notion_update_view", ["notion-update-view"]],
  ["_notion_query_data_sources", ["notion-query-data-sources", "notion-query-database-view"]],
  ["_notion_query_meeting_notes", ["notion-query-meeting-notes"]],
  ["_notion_create_comment", ["notion-create-comment"]],
  ["_notion_get_comments", ["notion-get-comments"]],
  ["_notion_get_teams", ["notion-get-teams"]],
  ["_notion_get_users", ["notion-get-users"]],
]);

export function createOfficialNotionToolRegistrar(server) {
  const registerTool = server.registerTool.bind(server);
  return Object.freeze({
    registerTool(name, definition, handler) {
      const registered = registerTool(name, definition, handler);
      for (const alias of OFFICIAL_NOTION_ALIASES.get(name) ?? []) {
        registerTool(alias, definition, handler);
      }
      return registered;
    },
  });
}

export function registerNotionAsyncTaskTool(server, z) {
  server.registerTool(
    "notion-get-async-task",
    {
      title: "Get async task",
      description:
        "Retrieve a Notion-compatible async task. The stdio transport currently executes supported writes synchronously.",
      inputSchema: { task_id: z.string().describe("Async task id returned by a prior call") },
    },
    async ({ task_id }) => ({
      content: [{
        type: "text",
        text: `Async task ${task_id} was not found. Hanji stdio MCP executes supported writes synchronously.`,
      }],
      isError: true,
    }),
  );
}
