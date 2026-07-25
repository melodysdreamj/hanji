import {
  normalizeNotionMoveDestination,
  normalizeNotionMovePageIds,
  notionMoveBatchPositions,
} from "./notion-move-pages-contract.mjs";

function collectPageSubtree(pages, rootId) {
  const children = new Map();
  for (const page of pages) {
    if (!page.parentId) continue;
    children.set(page.parentId, [...(children.get(page.parentId) ?? []), page.id]);
  }
  const ids = new Set();
  const visit = (id) => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const childId of children.get(id) ?? []) visit(childId);
  };
  visit(rootId);
  return ids;
}

/** Build the stdio handler without hiding its mutable test client dependency. */
export function createNotionMovePagesHandler({
  eb,
  stripHanjiId,
  requireWorkspaceSelection,
  titleOf,
  pageUrl,
  okJson,
  fail,
}) {
  return async function handleNotionMovePages({
    workspace_id = undefined,
    teamspace_id = undefined,
    page_or_database_ids = undefined,
    page_ids = undefined,
    page_id = undefined,
    new_parent = undefined,
    parent = undefined,
    after_page_id = undefined,
    before_page_id = undefined,
  } = {}) {
    try {
      const input = { page_or_database_ids, page_ids, page_id, new_parent, parent };
      // Fan-out is bounded before workspace bootstrap or backend lookup.
      const ids = normalizeNotionMovePageIds(input, stripHanjiId);
      let destination = normalizeNotionMoveDestination(input, stripHanjiId);
      const selected = await requireWorkspaceSelection(
        { workspace_id, teamspace_id },
        "_notion_move_pages",
      );
      if (selected.errorResult) return selected.errorResult;
      const pages = await eb.pageProjection({
        workspaceId: selected.workspaceId,
        includeTrash: true,
      });
      const pagesById = Object.fromEntries(pages.map((page) => [page.id, page]));
      let destinationParent = null;
      if (destination.parentId) {
        destinationParent = pagesById[destination.parentId] ?? null;
        if (!destinationParent || destinationParent.inTrash || destinationParent.isLocked) {
          throw new Error("Destination parent was not found or is locked.");
        }
        if (destination.requestedType === "page_id" && destinationParent.kind === "database") {
          destination = {
            ...destination,
            parentType: "database",
            notionParent: { type: "data_source_id", data_source_id: destination.parentId },
          };
        }
        if (destination.parentType === "database" && destinationParent.kind !== "database") {
          throw new Error("Destination parent was not found.");
        }
        if (destination.parentType === "page" && destinationParent.kind === "database") {
          throw new Error("Destination parent was not found.");
        }
      }

      const moved = [];
      const notFound = [];
      const candidates = [];
      for (const id of ids) {
        const page = pagesById[id];
        if (!page) {
          notFound.push(id);
          continue;
        }
        if (page.inTrash) throw new Error(`Cannot move "${titleOf(page)}" while it is in trash.`);
        const sourceParent = page.parentId ? pagesById[page.parentId] : null;
        if (sourceParent?.isLocked) {
          throw new Error(`Cannot move "${titleOf(page)}" from a locked parent.`);
        }
        if (destination.parentId && collectPageSubtree(pages, page.id).has(destination.parentId)) {
          throw new Error("Cannot move a page inside itself or one of its descendants.");
        }
        candidates.push(page);
      }

      const positions = notionMoveBatchPositions(
        pages,
        candidates.map((page) => page.id),
        destination,
        after_page_id ? stripHanjiId(after_page_id) : undefined,
        before_page_id ? stripHanjiId(before_page_id) : undefined,
      );
      const move = (page, dryRun) => eb.moveNotionPage(page, {
        parentId: destination.parentId,
        parentType: destination.parentType,
        parent: destinationParent,
        position: positions[page.id],
        dryRun,
      });

      // Every canonical planner succeeds before the first actual mutation.
      for (const page of candidates) await move(page, true);
      for (const page of candidates) {
        const result = await move(page, false);
        moved.push({
          id: result.page.id,
          title: titleOf(result.page),
          url: pageUrl(result.page.id),
          parent: result.parentType === "workspace"
            ? { type: "workspace" }
            : { type: result.parentType, id: result.parentId },
          position: result.position,
        });
      }
      return okJson({ moved, not_found: notFound });
    } catch (error) {
      return fail(error);
    }
  };
}
