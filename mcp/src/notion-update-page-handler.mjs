export const NOTION_UPDATE_PAGE_MAX_CONTENT_UPDATES = 100;

const PROTECTED_CHILD_BLOCK_TYPES = new Set([
  "child_page",
  "child_database",
  "inline_database",
]);

function countMatches(value, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= value.length - needle.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) break;
    count += 1;
    offset = index + needle.length;
  }
  return count;
}

/** @param {{ position?: { type?: unknown }, after?: unknown }} input */
export function normalizeNotionInsertTarget(input) {
  const { position, after } = input;
  if (position !== undefined && after !== undefined) {
    throw new Error("insert_content.after and insert_content.position cannot both be provided.");
  }
  if (after !== undefined && (typeof after !== "string" || after.length === 0)) {
    throw new Error("insert_content.after must be a non-empty string.");
  }
  if (position !== undefined) {
    if (!position || typeof position !== "object" || Array.isArray(position)) {
      throw new Error("insert_content.position must be an object.");
    }
    if (position.type !== "start" && position.type !== "end") {
      throw new Error("insert_content.position.type must be start or end.");
    }
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(position === undefined ? {} : { position: { type: position.type } }),
  };
}

export function normalizeNotionContentUpdates(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("update_content requires content_updates.");
  }
  if (value.length > NOTION_UPDATE_PAGE_MAX_CONTENT_UPDATES) {
    throw new Error(
      `content_updates must contain at most ${NOTION_UPDATE_PAGE_MAX_CONTENT_UPDATES} entries.`,
    );
  }
  return value.map((update) => {
    if (!update || typeof update !== "object" || Array.isArray(update)) {
      throw new Error("Each content update requires old_str and new_str strings.");
    }
    if (typeof update.old_str !== "string" || typeof update.new_str !== "string") {
      throw new Error("Each content update requires old_str and new_str strings.");
    }
    if (update.old_str.length === 0) {
      throw new Error("content_updates.old_str must not be empty.");
    }
    if (update.replace_all_matches !== undefined && typeof update.replace_all_matches !== "boolean") {
      throw new Error("content_updates.replace_all_matches must be a boolean.");
    }
    return {
      old_str: update.old_str,
      new_str: update.new_str,
      replace_all_matches: update.replace_all_matches === true,
    };
  });
}

/** @param {{ new_str?: unknown, content?: unknown }} input */
export function normalizeNotionReplaceContent({ new_str, content }) {
  const markdown = new_str ?? content;
  if (typeof markdown !== "string") {
    throw new Error("replace_content requires new_str or content to be a string.");
  }
  return markdown;
}

export function applyNotionContentUpdates(markdown, updates) {
  let next = String(markdown ?? "");
  for (const update of normalizeNotionContentUpdates(updates)) {
    const matches = countMatches(next, update.old_str);
    if (matches === 0) throw new Error("Could not find old_str in page content.");
    if (matches > 1 && !update.replace_all_matches) {
      throw new Error(
        "content_updates.old_str matched more than once; set replace_all_matches to true.",
      );
    }
    next = update.replace_all_matches
      ? next.split(update.old_str).join(update.new_str)
      : next.replace(update.old_str, update.new_str);
  }
  return next;
}

export function selectedNotionMarkdownRange(markdown, selector) {
  const marker = selector.indexOf("...");
  if (marker < 0) {
    const start = markdown.indexOf(selector);
    return start < 0 ? null : { start, end: start + selector.length };
  }
  const prefix = selector.slice(0, marker);
  const suffix = selector.slice(marker + 3);
  const start = markdown.indexOf(prefix);
  if (start < 0) return null;
  const suffixStart = markdown.indexOf(suffix, start + prefix.length);
  if (suffixStart < 0) return null;
  return { start, end: suffixStart + suffix.length };
}

function protectedBlockId(block) {
  return block?.content?.childPageId || block?.id || "unknown";
}

function protectedBlocks(blocks) {
  return (blocks ?? []).filter((block) => PROTECTED_CHILD_BLOCK_TYPES.has(block?.type));
}

function throwProtectedChildError(ids) {
  throw new Error(
    `The update would delete child pages or databases (${ids.slice(0, 10).join(", ")}). `
      + "Set allow_deleting_content to true to permit this operation.",
  );
}

function assertFullReplacementAllowed(blocks, childPages, allowDeletingContent) {
  if (allowDeletingContent) return;
  const ids = new Set(protectedBlocks(blocks).map(protectedBlockId));
  for (const child of childPages ?? []) {
    if (child?.parentType === "page" && child?.parentId && !child?.inTrash) ids.add(child.id);
  }
  if (ids.size) throwProtectedChildError([...ids]);
}

function assertTargetedUpdatePreservesChildren(
  blocks,
  currentMarkdown,
  nextMarkdown,
  allowDeletingContent,
  blocksToMarkdown,
) {
  if (allowDeletingContent) return;
  const removed = [];
  for (const block of protectedBlocks(blocks)) {
    const reference = blocksToMarkdown([{ ...block, parentId: null }]);
    if (!reference) {
      removed.push(protectedBlockId(block));
      continue;
    }
    if (countMatches(nextMarkdown, reference) < countMatches(currentMarkdown, reference)) {
      removed.push(protectedBlockId(block));
    }
  }
  if (removed.length) throwProtectedChildError(removed);
}

function normalizeAllowDeletingContent(value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error("allow_deleting_content must be a boolean.");
  }
  return value === true;
}

export function createNotionUpdatePageHandler(deps) {
  const {
    MCP_ACTOR,
    PAGE_TEMPLATES,
    appendMarkdown,
    blocksToMarkdown,
    eb,
    fail,
    insertMarkdownBlocks,
    insertTemplateBlocks,
    lockedPageMessage,
    markdownToBlocks,
    ok,
    okJson,
    pageEditAudit,
    pageIconPatch,
    pagePresentationPatch,
    pageUrl,
    persistableDatabaseRowProperties,
    replaceMarkdown,
    requireMatchingWorkspace,
    requireWorkspaceSelection,
    rowPatchFromProperties,
    stripHanjiId,
    titleOf,
    updateMarkdownPreservingIds,
  } = deps;

  /** @param {Record<string, any>} input */
  return async function handleNotionUpdatePage(input) {
    const {
      workspace_id,
      teamspace_id,
      pageId,
      page_id,
      command,
      title,
      properties,
      content,
      new_str,
      content_updates,
      position,
      after,
      template_id,
      verification_status,
      verification_expiry_days,
      allow_deleting_content,
      icon,
      iconType,
      cover,
      coverPosition,
      font,
      smallText,
      fullWidth,
      backlinksDisplay,
      pageCommentsDisplay,
      locked,
    } = input;
    try {
      const insertTarget = command === "insert_content"
        ? normalizeNotionInsertTarget({ position, after })
        : {};
      const updates = command === "update_content"
        ? normalizeNotionContentUpdates(content_updates)
        : [];
      const replacementMarkdown = command === "replace_content"
        ? normalizeNotionReplaceContent({ new_str, content })
        : undefined;
      const allowDeletingContent = normalizeAllowDeletingContent(allow_deleting_content);
      const requiredWorkspace = await requireWorkspaceSelection(
        { workspace_id, teamspace_id },
        "_notion_update_page",
      );
      if (requiredWorkspace.errorResult) return requiredWorkspace.errorResult;
      const targetPageId = stripHanjiId(pageId ?? page_id);
      if (!targetPageId) throw new Error("Provide pageId or page_id.");
      const page = await eb.getOne("pages", targetPageId);
      if (!page || !page.id) return ok(`Page ${targetPageId} not found.`);
      const matched = await requireMatchingWorkspace(
        { workspace_id: requiredWorkspace.workspaceId },
        page,
        "_notion_update_page",
        "Page",
      );
      if (matched.errorResult) return matched.errorResult;
      if (page.isLocked && locked !== false && command !== "update_verification") {
        return ok(lockedPageMessage(page));
      }

      if (command === "update_properties") {
        const patch = {};
        if (page.parentType === "database" && page.parentId) {
          const props = await eb.dbProperties(page.parentId);
          const { patch: rowPatch, unknown, readonly } = rowPatchFromProperties(props, properties ?? {});
          if (Object.keys(rowPatch.properties ?? {}).length || rowPatch.title !== undefined) {
            const next = {};
            if (rowPatch.title !== undefined) next.title = rowPatch.title;
            if (Object.keys(rowPatch.properties ?? {}).length) {
              next.properties = persistableDatabaseRowProperties({
                ...(page.properties ?? {}),
                ...(rowPatch.properties ?? {}),
              });
            }
            await eb.updateDatabaseRow(page.id, { ...next, ...pageEditAudit() });
          }
          Object.assign(patch, pageIconPatch({ icon, iconType }, page), pagePresentationPatch({ cover }));
          if (Object.keys(patch).length) {
            await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
          }
          return okJson({
            id: page.id,
            url: pageUrl(page.id),
            ignored_properties: unknown,
            skipped_readonly_properties: readonly,
          });
        }
        const nextTitle = properties?.title ?? properties?.Name ?? properties?.name;
        if (nextTitle !== undefined) patch.title = String(nextTitle);
        Object.assign(patch, pageIconPatch({ icon, iconType }, page), pagePresentationPatch({ cover }));
        if (Object.keys(patch).length) {
          await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
        }
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "insert_content") {
        const markdown = content ?? new_str ?? "";
        if (!markdown.trim()) throw new Error("insert_content requires content.");
        if (insertTarget.position?.type === "start") {
          const rootBlocks = (await eb.blocks(page.id)).filter((block) => !block.parentId);
          const firstPosition = rootBlocks.reduce(
            (minimum, block) => Math.min(minimum, block.position ?? 0),
            1,
          );
          const parsed = markdownToBlocks(markdown);
          await insertMarkdownBlocks(page.id, parsed, firstPosition - parsed.length - 1);
        } else if (insertTarget.after !== undefined) {
          const blocks = await eb.blocks(page.id);
          const currentMarkdown = blocksToMarkdown(blocks);
          const range = selectedNotionMarkdownRange(currentMarkdown, insertTarget.after);
          if (!range) throw new Error("insert_content.after did not match page content.");
          const nextMarkdown = `${currentMarkdown.slice(0, range.end)}\n${markdown}${currentMarkdown.slice(range.end)}`;
          assertTargetedUpdatePreservesChildren(
            blocks,
            currentMarkdown,
            nextMarkdown,
            false,
            blocksToMarkdown,
          );
          await updateMarkdownPreservingIds(page.id, nextMarkdown, blocks);
        } else {
          await appendMarkdown(page.id, markdown);
        }
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "replace_content") {
        if (!allowDeletingContent) {
          const [blocks, pages] = await Promise.all([
            eb.blocks(page.id),
            eb.pageProjection({ workspaceId: page.workspaceId }),
          ]);
          assertFullReplacementAllowed(
            blocks,
            pages.filter((child) => child.parentId === page.id),
            allowDeletingContent,
          );
        }
        await replaceMarkdown(page.id, replacementMarkdown);
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "update_content") {
        const blocks = await eb.blocks(page.id);
        const currentMarkdown = blocksToMarkdown(blocks);
        const markdown = applyNotionContentUpdates(currentMarkdown, updates);
        assertTargetedUpdatePreservesChildren(
          blocks,
          currentMarkdown,
          markdown,
          allowDeletingContent,
          blocksToMarkdown,
        );
        await updateMarkdownPreservingIds(page.id, markdown, blocks);
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id) });
      }

      if (command === "apply_template") {
        if (!template_id) throw new Error("apply_template requires template_id.");
        let inserted = [];
        if (page.parentType === "database" && page.parentId) {
          const template = (await eb.dbTemplates(page.parentId)).find((item) => item.id === template_id);
          if (!template) throw new Error(`Template ${template_id} not found.`);
          inserted = await insertTemplateBlocks(page.id, template.blocks ?? []);
        } else {
          const template = PAGE_TEMPLATES.find((item) => item.id === template_id);
          if (!template) throw new Error(`Template ${template_id} not found.`);
          inserted = await insertTemplateBlocks(page.id, template.blocks ?? []);
        }
        await eb.update("pages", page.id, pageEditAudit());
        return okJson({ id: page.id, url: pageUrl(page.id), appended_blocks: inserted.length });
      }

      if (command === "update_verification") {
        const verified = verification_status === "verified";
        const expiresAt = verified && verification_expiry_days
          ? new Date(Date.now() + verification_expiry_days * 24 * 60 * 60 * 1000).toISOString()
          : null;
        await eb.update("pages", page.id, {
          verifiedAt: verified ? new Date().toISOString() : null,
          verifiedBy: verified ? MCP_ACTOR : null,
          verificationExpiresAt: verified ? expiresAt : null,
          ...pageEditAudit(),
        });
        return okJson({
          id: page.id,
          url: pageUrl(page.id),
          verification_status: verified ? "verified" : "unverified",
        });
      }

      const patch = {};
      if (title !== undefined) patch.title = title;
      Object.assign(patch, pageIconPatch({ icon, iconType }, page));
      Object.assign(
        patch,
        pagePresentationPatch({
          cover,
          coverPosition,
          font,
          smallText,
          fullWidth,
          backlinksDisplay,
          pageCommentsDisplay,
          locked,
        }),
      );
      if (Object.keys(patch).length === 0) return ok(`No changes supplied for "${titleOf(page)}".`);
      const updated = await eb.update("pages", page.id, { ...patch, ...pageEditAudit() });
      return ok(`Updated "${titleOf(updated)}".`);
    } catch (error) {
      return fail(error);
    }
  };
}
