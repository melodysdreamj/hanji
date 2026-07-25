import type { NotionImportConnectionKind } from './notion-import-connections';

export type NotionImportStatus = 'queued' | 'discovering' | 'ready' | 'completed' | 'failed' | 'cancelled';

export type NotionImportWarning = {
  code: string;
  message: string;
  notionId?: string;
  notionObject?: string;
};

export interface NotionImportJob {
  id: string;
  workspaceId: string;
  source: 'notion_api';
  connectionKind: NotionImportConnectionKind;
  connectionId?: string | null;
  status: NotionImportStatus;
  phase: string;
  actorId?: string;
  parentPageId?: string | null;
  rootNotionPageIds?: string[];
  rootNotionDataSourceIds?: string[];
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  apiVersion: string;
  options?: Record<string, unknown>;
  counts?: Record<string, number>;
  progress?: Record<string, unknown>;
  report?: Record<string, unknown>;
  error?: string | null;
  retryOfJobId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
  fileCleanupStatus?: 'pending' | 'complete' | null;
  fileCleanupRequestedAt?: string | null;
  fileCleanupCompletedAt?: string | null;
  /** Internal pointer to the only discovery-item generation readers may use. */
  activeItemGeneration?: string | null;
  /** Internal revision for the immutable graph consumed by resumable apply. */
  itemSnapshotRevision?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotionImportItem {
  id: string;
  workspaceId: string;
  jobId: string;
  /** Internal copy-on-write generation; legacy rows intentionally store null. */
  itemGeneration?: string | null;
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status: string;
  phase: string;
  localId?: string | null;
  localType?: string | null;
  /** Scalar discovery state used by metadata-free projected resume queries. */
  enrichmentComplete?: boolean;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface NotionImportMapping {
  id: string;
  workspaceId: string;
  jobId: string;
  mappingKey?: string;
  notionId: string;
  notionType: string;
  localId: string;
  localType: string;
  relationKind: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface DiscoveryWarningBag {
  warnings: NotionImportWarning[];
  missingPermissions: NotionImportWarning[];
  unsupported: NotionImportWarning[];
}

export interface ImportConversionReport {
  summary: Record<string, number>;
  warnings: NotionImportWarning[];
  unsupported: NotionImportWarning[];
  missingPermissions: NotionImportWarning[];
  unresolvedReferences: NotionImportWarning[];
}

export interface NotionImportPlan {
  status: 'ready' | 'blocked';
  generatedAt: string;
  counts: Record<string, number>;
  estimatedWrites: Record<string, number>;
  conversion: ImportConversionReport;
  canApply: boolean;
}
