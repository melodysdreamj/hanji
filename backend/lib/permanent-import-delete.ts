import type { DbRef } from './app-types';
import { listAll } from './table-utils';

const IMPORT_ARTIFACT_SCAN_LIMIT = 100_000;

interface NotionImportArtifact {
  id: string;
  workspaceId: string;
  localId?: string | null;
  metadata?: unknown;
}

export interface DeletedNotionImportArtifacts {
  itemIds: string[];
  mappingIds: string[];
}

/**
 * Import metadata is JSON, but a defensive recursion/cycle guard must fail
 * closed: an opaque over-deep record may contain a deleted local identifier,
 * so retaining it would preserve source content after permanent deletion.
 */
export function metadataReferencesDeletedIds(
  value: unknown,
  deletedIds: ReadonlySet<string>,
  depth = 0,
  ancestors: ReadonlySet<object> = new Set<object>(),
): boolean {
  if (typeof value === 'string') return deletedIds.has(value);
  if (!value || typeof value !== 'object') return false;
  if (depth > 32 || ancestors.has(value)) return true;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.some((item) =>
      metadataReferencesDeletedIds(item, deletedIds, depth + 1, nextAncestors));
  }
  return Object.entries(value as Record<string, unknown>).some(([key, item]) =>
    deletedIds.has(key)
    || metadataReferencesDeletedIds(item, deletedIds, depth + 1, nextAncestors));
}

function referencesDeletedContent(
  artifact: NotionImportArtifact,
  workspaceId: string,
  deletedIds: ReadonlySet<string>,
) {
  return artifact.workspaceId === workspaceId
    && (
      (typeof artifact.localId === 'string' && deletedIds.has(artifact.localId))
      || metadataReferencesDeletedIds(artifact.metadata, deletedIds)
    );
}

/**
 * Notion staging rows intentionally have no FK to the heterogeneous local
 * records they reference. Scan the workspace's bounded import corpus and
 * return every direct or nested reference that permanent deletion must purge.
 * Exceeding the explicit ceiling aborts before page deletion, leaving the
 * durable deletion fence in place instead of silently retaining private data.
 */
export async function collectNotionImportArtifactsForDeletedContent(
  db: DbRef,
  workspaceId: string,
  deletedIds: Iterable<string>,
): Promise<DeletedNotionImportArtifacts> {
  const idSet = new Set(deletedIds);
  if (idSet.size === 0) return { itemIds: [], mappingIds: [] };

  const [items, mappings] = await Promise.all([
    listAll(
      db.table<NotionImportArtifact>('notion_import_items').where(
        'workspaceId',
        '==',
        workspaceId,
      ),
      {
        maxItems: IMPORT_ARTIFACT_SCAN_LIMIT,
        allowLargeMaterialization: true,
        label: 'Notion import item permanent-delete scan',
      },
    ),
    listAll(
      db.table<NotionImportArtifact>('notion_import_mappings').where(
        'workspaceId',
        '==',
        workspaceId,
      ),
      {
        maxItems: IMPORT_ARTIFACT_SCAN_LIMIT,
        allowLargeMaterialization: true,
        label: 'Notion import mapping permanent-delete scan',
      },
    ),
  ]);

  return {
    itemIds: items
      .filter((item) => referencesDeletedContent(item, workspaceId, idSet))
      .map((item) => item.id),
    mappingIds: mappings
      .filter((mapping) => referencesDeletedContent(mapping, workspaceId, idSet))
      .map((mapping) => mapping.id),
  };
}
