export const NOTION_MOVE_PAGES_MAX_IDS = 100;

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function present(value) {
  return value !== undefined && value !== null;
}

function oneAlias(input, keys, label, normalizeId) {
  const supplied = keys.filter((key) => present(input[key]));
  if (supplied.length > 1) {
    throw badRequest(`Provide only one of ${keys.join(" or ")} for ${label}.`);
  }
  if (!supplied.length) return "";
  const value = input[supplied[0]];
  if (typeof value !== "string" || !value.trim()) {
    throw badRequest(`${supplied[0]} must be a non-empty string.`);
  }
  const id = normalizeId(value);
  if (!id) throw badRequest(`${supplied[0]} must contain a valid id or URL.`);
  return id;
}

/** Bound raw fan-out before reading any member or performing I/O. */
export function normalizeNotionMovePageIds(args, normalizeId) {
  const selectors = ["page_or_database_ids", "page_ids", "page_id"];
  const supplied = selectors.filter((key) => present(args[key]));
  if (supplied.length > 1) {
    throw badRequest("Provide only one of page_or_database_ids, page_ids, or page_id.");
  }
  if (!supplied.length) {
    throw badRequest("Provide page_or_database_ids, page_ids, or page_id.");
  }

  const selector = supplied[0];
  const value = args[selector];
  let raw;
  if (selector === "page_id") raw = [value];
  else if (Array.isArray(value)) raw = value;
  else throw badRequest(`${selector} must be an array.`);

  if (raw.length > NOTION_MOVE_PAGES_MAX_IDS) {
    throw badRequest(
      `Move requests may contain at most ${NOTION_MOVE_PAGES_MAX_IDS} page or database ids.`,
    );
  }
  if (!raw.length) throw badRequest("Provide at least one page or database id.");

  const normalized = [];
  const seen = new Set();
  for (let index = 0; index < raw.length; index += 1) {
    const valueAtIndex = raw[index];
    if (typeof valueAtIndex !== "string" || !valueAtIndex.trim()) {
      throw badRequest(`${selector}[${index}] must be a non-empty string.`);
    }
    const id = normalizeId(valueAtIndex);
    if (!id) throw badRequest(`${selector}[${index}] must contain a valid id or URL.`);
    if (!seen.has(id)) {
      seen.add(id);
      normalized.push(id);
    }
  }
  return normalized;
}

function normalizedParentType(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw badRequest("new_parent.type must be a string.");
  const type = value.trim().toLowerCase().replace(/[ -]+/g, "_");
  if (!type) return "";
  if ([
    "workspace",
    "workspace_id",
    "page",
    "page_id",
    "database",
    "database_id",
    "data_source",
    "data_source_id",
  ].includes(type)) return type;
  throw badRequest(`Unsupported move parent type "${type}".`);
}

export function normalizeNotionMoveDestination(args, normalizeId) {
  if (present(args.new_parent) && present(args.parent)) {
    throw badRequest("Provide only one of new_parent or parent.");
  }
  const value = present(args.new_parent) ? args.new_parent : args.parent;
  if (present(value) && !isRecord(value)) {
    throw badRequest("new_parent must be an object.");
  }
  const input = isRecord(value) ? value : {};
  const pageId = oneAlias(input, ["page_id", "parent_page_id"], "page parent", normalizeId);
  const databaseId = oneAlias(
    input,
    ["data_source_id", "database_id"],
    "data source parent",
    normalizeId,
  );
  if (pageId && databaseId) {
    throw badRequest("Move parent must identify exactly one page or data source.");
  }

  const type = normalizedParentType(input.type);
  if (!type && !pageId && !databaseId) {
    return {
      parentId: null,
      parentType: "workspace",
      requestedType: "workspace",
      notionParent: null,
    };
  }

  if (type === "workspace" || type === "workspace_id") {
    if (pageId || databaseId) {
      throw badRequest("A workspace move parent must not include a page or data source id.");
    }
    return {
      parentId: null,
      parentType: "workspace",
      requestedType: "workspace",
      notionParent: null,
    };
  }

  const pageType = type === "page" || type === "page_id" || (!type && Boolean(pageId));
  if (pageType) {
    if (!pageId || databaseId) {
      throw badRequest("A page move parent requires exactly one page_id or parent_page_id.");
    }
    return {
      parentId: pageId,
      parentType: "page",
      requestedType: type === "page_id" ? "page_id" : "page",
      notionParent: { type: "page_id", page_id: pageId },
    };
  }

  const databaseType = ["database", "database_id", "data_source", "data_source_id"].includes(type)
    || (!type && Boolean(databaseId));
  if (databaseType) {
    if (!databaseId || pageId) {
      throw badRequest("A data source move parent requires exactly one data_source_id or database_id.");
    }
    return {
      parentId: databaseId,
      parentType: "database",
      requestedType: type || (input.data_source_id ? "data_source_id" : "database_id"),
      notionParent: { type: "data_source_id", data_source_id: databaseId },
    };
  }

  throw badRequest("Move parent type and id do not match.");
}

export function notionMoveBatchPositions(
  pages,
  candidateIds,
  destination,
  afterPageId = undefined,
  beforePageId = undefined,
) {
  const moving = new Set(candidateIds);
  if (afterPageId && moving.has(afterPageId)) {
    throw badRequest("after_page_id cannot identify a page in the move batch.");
  }
  if (beforePageId && moving.has(beforePageId)) {
    throw badRequest("before_page_id cannot identify a page in the move batch.");
  }
  if (afterPageId && beforePageId && afterPageId === beforePageId) {
    throw badRequest("after_page_id and before_page_id must identify different siblings.");
  }

  const siblings = pages
    .filter((page) => {
      if (page.inTrash || moving.has(page.id)) return false;
      if (destination.parentType === "workspace") {
        return !page.parentId || page.parentType === "workspace";
      }
      return page.parentId === destination.parentId && page.parentType === destination.parentType;
    })
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const afterIndex = afterPageId ? siblings.findIndex((page) => page.id === afterPageId) : -1;
  const beforeIndex = beforePageId ? siblings.findIndex((page) => page.id === beforePageId) : -1;
  if (afterPageId && afterIndex < 0) {
    throw badRequest(`after_page_id ${afterPageId} is not a destination sibling.`);
  }
  if (beforePageId && beforeIndex < 0) {
    throw badRequest(`before_page_id ${beforePageId} is not a destination sibling.`);
  }
  if (afterIndex >= 0 && beforeIndex >= 0 && afterIndex >= beforeIndex) {
    throw badRequest("after_page_id must come before before_page_id.");
  }

  let lower;
  let upper;
  if (afterIndex >= 0) {
    lower = siblings[afterIndex]?.position ?? 0;
    upper = beforeIndex >= 0
      ? siblings[beforeIndex]?.position ?? lower + candidateIds.length + 1
      : siblings[afterIndex + 1]?.position;
  } else if (beforeIndex >= 0) {
    upper = siblings[beforeIndex]?.position ?? 0;
    lower = siblings[beforeIndex - 1]?.position;
  } else {
    lower = siblings[siblings.length - 1]?.position ?? 0;
  }

  const result = {};
  if (lower === undefined && upper !== undefined) {
    candidateIds.forEach((id, index) => {
      result[id] = upper - (candidateIds.length - index);
    });
    return result;
  }
  if (upper === undefined) {
    const base = lower ?? 0;
    candidateIds.forEach((id, index) => {
      result[id] = base + index + 1;
    });
    return result;
  }
  const base = lower ?? upper - candidateIds.length - 1;
  const step = (upper - base) / (candidateIds.length + 1);
  if (!(step > 0)) throw badRequest("Destination sibling positions are invalid.");
  candidateIds.forEach((id, index) => {
    result[id] = base + step * (index + 1);
  });
  return result;
}
