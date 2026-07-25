// Domain model — mirrors the EdgeBase `app` block schema (backend/edgebase.config.ts).
// `id`, `createdAt`, `updatedAt` are injected by EdgeBase on every row.

import type { NotionChartAggregate } from "../../../shared/notion-chart-aggregates.mjs";
import type { FormulaValue } from "../../../shared/database/formula-core";

export interface Timestamped {
  id: string;
  createdAt?: string;
  updatedAt?: string;
}

export type ComputedPropertyValue = {
  value: FormulaValue;
  formatted: string;
};

export interface Workspace extends Timestamped {
  organizationId?: string | null;
  name: string;
  icon?: string;
  domain?: string;
  ownerId?: string;
}

export type TeamspaceAccess = "open" | "closed" | "private";
export type TeamspaceMemberRole = "owner" | "member";

export interface Teamspace extends Timestamped {
  workspaceId: string;
  name: string;
  icon?: string | null;
  description?: string | null;
  access: TeamspaceAccess;
  memberPageRole?: ShareRole;
  openPageRole?: ShareRole;
  membersCanInvite?: boolean;
  membersCanEditSidebar?: boolean;
  archivedAt?: string | null;
  archivedBy?: string | null;
  writeToken?: string | null;
  joined?: boolean;
  membershipSource?: "explicit" | "default";
  role?: TeamspaceMemberRole;
  canJoin?: boolean;
  canRequest?: boolean;
  requestPending?: boolean;
  isDefault?: boolean;
  createdBy?: string;
  updatedBy?: string;
}

export interface TeamspaceSettings extends Timestamped {
  workspaceId: string;
  defaultTeamspaceId?: string | null;
  ownersOnlyCreate?: boolean;
  lifecycleToken?: string | null;
  updatedBy?: string | null;
}

export interface TeamspaceMember extends Timestamped {
  workspaceId: string;
  teamspaceId: string;
  principalType: "user" | "group";
  principalId: string;
  workspaceMemberId?: string | null;
  role: TeamspaceMemberRole;
  createdBy?: string | null;
}

export interface TeamspaceJoinRequest extends Timestamped {
  workspaceId: string;
  teamspaceId: string;
  userId: string;
  workspaceMemberId: string;
  status: "pending" | "approved" | "denied" | string;
  createdBy: string;
  decidedBy?: string | null;
  decidedAt?: string | null;
}

export type NotionImportStatus =
  | "queued"
  | "discovering"
  | "ready"
  | "completed"
  | "failed"
  | "cancelled";

export type NotionImportConnectionKind =
  | "oauth"
  | "personal_access_token"
  | "internal_integration"
  | "manual_token";

export type NotionImportConnectionStatus = "active" | "revoked" | "error";

export interface NotionImportConnection extends Timestamped {
  workspaceId: string;
  actorId?: string;
  name?: string;
  connectionKind: NotionImportConnectionKind;
  status: NotionImportConnectionStatus;
  apiVersion: string;
  notionWorkspaceId?: string | null;
  notionWorkspaceName?: string | null;
  tokenFingerprint?: string | null;
  credentialAlgorithm?: string | null;
  credentialKeyId?: string | null;
  metadata?: Record<string, unknown>;
  lastValidatedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
  error?: string | null;
  hasStoredCredential?: boolean;
}

export interface NotionImportRootCandidate {
  id: string;
  notionObject: "page" | "data_source";
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  reason?: "workspace_parent" | "accessible_parent_missing";
}

export interface NotionImportRootScanItem {
  id: string;
  notionObject: "page" | "data_source";
  title: string;
  parentNotionId?: string | null;
  parentType?: string | null;
  createdTime?: string | null;
  lastEditedTime?: string | null;
  url?: string | null;
  icon?: unknown;
  archived?: boolean;
  inTrash?: boolean;
}

export type McpWorkspaceAccess = "all_accessible" | "selected";

export interface McpOAuthGrant extends Timestamped {
  clientId: string;
  clientName: string;
  resource: string;
  scopes: string[];
  workspaceAccess: McpWorkspaceAccess;
  workspaceIds: string[];
  pageIds: string[];
  databaseIds: string[];
  readOnly: boolean;
  status: "active" | "revoked";
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

export interface NotionImportJob extends Timestamped {
  workspaceId: string;
  source: "notion_api";
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
}

export interface NotionImportItem extends Timestamped {
  workspaceId: string;
  jobId: string;
  notionId: string;
  notionObject: string;
  parentNotionId?: string | null;
  title?: string;
  status: string;
  phase: string;
  localId?: string | null;
  localType?: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface CollaborationCrdtUpdateOperation {
  engine: "yjs";
  schemaVersion: number;
  documentId: string;
  updateBase64: string;
  stateVectorBase64?: string;
  originClientId?: string;
}

export type CollaborationBlockStructureAction =
  | "create"
  | "move"
  | "indent"
  | "outdent"
  | "delete"
  | "restore";

export interface CollaborationBlockStructureBlock {
  id: string;
  pageId: string;
  parentId?: string | null;
  type?: string;
  content?: Record<string, unknown>;
  plainText?: string;
  position: number;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CollaborationBlockStructureOperation {
  engine: "block_structure";
  schemaVersion: number;
  action: CollaborationBlockStructureAction;
  blockIds: string[];
  before?: CollaborationBlockStructureBlock[];
  after?: CollaborationBlockStructureBlock[];
  originClientId?: string;
}

export type PageParentType = "workspace" | "page" | "database";
export type PageKind = "page" | "database";
export type IconType = "none" | "emoji" | "image";
export type PageFont = "default" | "serif" | "mono";
export type BacklinksDisplay = "default" | "expanded" | "off";
export type PageCommentsDisplay = "default" | "expanded" | "off";

export interface PageLayoutHints {
  hasRootColumnList?: boolean;
  hasRootInlineDatabase?: boolean;
}

export interface DatabaseSubitemsFeature {
  childrenPropertyId: string;
  enabled: true;
  nestedPropertyId?: string;
  parentPropertyId: string;
  revision: number;
  showToggleOnTitle?: boolean;
}

interface DatabaseDependenciesFeatureBase {
  avoidWeekends: boolean;
  dataKey?: string;
  enabled: true;
  predecessorPropertyId: string;
  revision: number;
  shiftMode: "overlap" | "maintain_spacing" | "none";
  successorPropertyId: string;
}

export type DatabaseDependenciesFeature = DatabaseDependenciesFeatureBase & (
  | {
      dateMode?: "range";
      datePropertyId: string;
    }
  | {
      dateMode: "separate";
      endDatePropertyId: string;
      startDatePropertyId: string;
    }
);

type DisabledDatabaseTaskFeature<T extends { enabled: true }> = T extends unknown
  ? Omit<T, "enabled"> & { enabled: false }
  : never;

export interface PreservedDatabaseTaskFeatures {
  dependencies?: Array<DisabledDatabaseTaskFeature<DatabaseDependenciesFeature>>;
  subitems?: Array<DisabledDatabaseTaskFeature<DatabaseSubitemsFeature>>;
}

export interface DatabaseFeatures {
  dependencies?: DatabaseDependenciesFeature;
  preservedTaskFeatures?: PreservedDatabaseTaskFeatures;
  subitems?: DatabaseSubitemsFeature;
}

export interface Page extends Timestamped {
  workspaceId: string;
  parentId?: string | null;
  parentType: PageParentType;
  teamspaceId?: string | null;
  teamspacePermissionMode?: "inherit" | "restricted";
  kind: PageKind;
  title: string;
  icon?: string;
  iconType: IconType;
  cover?: string;
  coverPosition?: number;
  font?: PageFont;
  smallText?: boolean;
  fullWidth?: boolean;
  isLocked?: boolean;
  backlinksDisplay?: BacklinksDisplay;
  pageCommentsDisplay?: PageCommentsDisplay;
  isWiki?: boolean;
  wikiRootId?: string | null;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verificationExpiresAt?: string | null;
  /** Column values when this page is a row in a database: { [propertyId]: value } */
  properties?: Record<string, unknown>;
  /** Server-owned database feature bindings. Property names remain presentation-only. */
  databaseFeatures?: DatabaseFeatures;
  databaseFeaturesRevision?: number;
  /** Indexed hierarchy authority for database rows; empty means a root row. */
  subitemParentId?: string;
  /** Server-maintained count of live direct children; child IDs remain cursor-loaded. */
  subitemChildCount?: number;
  /** Transient restricted-ancestor projection; never persisted as page content. */
  __structuralPlaceholder?: true;
  /** Backend-computed projection values for read-only formula/rollup properties. */
  __computed?: Record<string, ComputedPropertyValue>;
  /** Transient client-side order from the remote database row query. Never persisted. */
  __databaseRowOrder?: number;
  isFavorite?: boolean;
  /** Local Notion-style "Share to web" flag. It controls UI/link semantics only. */
  isPublic?: boolean;
  /** Non-persisted hints from bootstrap so first paint can match late-loaded block layout. */
  layoutHints?: PageLayoutHints;
  inTrash?: boolean;
  trashedAt?: string | null;
  position: number;
  createdBy?: string;
  lastEditedBy?: string;
  /** Server receipt for page/row update replay and same-client chaining. */
  lastMutationId?: string;
}

export interface PageOwner extends Timestamped {
  id: string;
  workspaceId: string;
  pageId: string;
  wikiRootId: string;
  userId: string;
  createdBy?: string;
}

// ── Blocks ────────────────────────────────────────────────────────────
export type BlockType =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "heading_4"
  | "toggle_heading_1"
  | "toggle_heading_2"
  | "toggle_heading_3"
  | "toggle_heading_4"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "quote"
  | "callout"
  | "divider"
  | "code"
  | "equation"
  | "simple_table"
  | "image"
  | "video"
  | "audio"
  | "bookmark"
  | "embed"
  | "file"
  | "breadcrumb"
  | "table_of_contents"
  | "synced_block"
  | "button"
  | "tab"
  | "inline_database"
  | "column_list"
  | "column"
  | "child_page"
  | "link_to_page"
  | "child_database";

/** A run of text with formatting marks. */
export interface TextSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  color?: string; // named color, e.g. "red" or "blue_background"
  link?: string;
  commentId?: string;
  mention?: "page" | "date" | "person" | "external";
  pageId?: string;
  date?: string;
  userId?: string;
  iconUrl?: string;
}

/** type-specific content stored in blocks.content (json) */
export interface BlockContent {
  rich?: TextSpan[]; // text-bearing blocks
  checked?: boolean; // to_do
  collapsed?: boolean; // toggle / toggle heading
  language?: string; // code
  lineNumbers?: boolean; // code: show line-number gutter
  wrap?: boolean; // code: soft-wrap long lines
  expression?: string; // equation
  color?: string; // callout / colored blocks
  icon?: string; // callout icon
  url?: string; // image / video / audio / bookmark / embed / file
  fileName?: string; // file
  caption?: TextSpan[]; // image / code caption
  showCaption?: boolean; // media/embed/file caption is explicitly enabled
  altText?: string; // image accessibility description
  imageLink?: string; // destination opened when an image is clicked
  align?: "left" | "center" | "right"; // media alignment
  childPageId?: string; // child_page / link_to_page / child_database / inline_database link
  childPageTitle?: string; // imported linked page/database title snapshot
  childPageIcon?: string; // imported linked page/database icon snapshot
  childPageIconType?: IconType; // imported linked page/database icon type snapshot
  childPageKind?: PageKind; // imported linked target kind snapshot
  databaseViewId?: string; // inline_database linked view
  databaseViewIds?: string[]; // inline_database block-scoped view tabs
  linkedDatabaseSource?: boolean; // inline_database links an existing database source
  autoFocusDatabaseTitle?: boolean; // transient inline_database title focus handoff
  templateSelfFilter?: {
    sourceDatabaseId?: string;
    relationPropertyId?: string;
  };
  width?: number; // column ratio / media width percent
  table?: string[][]; // simple_table cells
  headerRow?: boolean; // simple_table
  headerColumn?: boolean; // simple_table
  syncedBlockId?: string; // synced_block copy source
  syncedPageId?: string; // synced_block copy source page
  buttonLabel?: string; // button
  buttonTemplate?: ButtonTemplateBlock[]; // button
  buttonActionDocument?: PageButtonActionDocument; // button shared server action authority
  notionButtonPartial?: boolean; // imported button whose Notion API action/label details were hidden
  notionBlock?: unknown; // imported Notion block metadata used for normalized rendering
}

export interface ButtonTemplateBlock {
  type: BlockType;
  content?: BlockContent;
  children?: ButtonTemplateBlock[];
}

export interface Block extends Timestamped {
  pageId: string;
  parentId?: string | null;
  type: BlockType;
  content?: BlockContent;
  plainText?: string;
  position: number;
  createdBy?: string;
  /** Server-authenticated actor for the latest persisted edit. */
  lastEditedBy?: string;
  /** Server receipt for update replay/idempotency; not user-authored content. */
  lastMutationId?: string;
}

// ── Database properties & views ──────────────────────────────────────
export type PropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "select"
  | "multi_select"
  | "status"
  | "date"
  | "person"
  | "checkbox"
  | "url"
  | "email"
  | "phone"
  | "files"
  | "created_time"
  | "last_edited_time"
  | "created_by"
  | "last_edited_by"
  | "relation"
  | "rollup"
  | "formula"
  | "unique_id"
  | "button"
  | "location"
  | "verification"
  | "last_visited_time"
  | "place";

export type ReadOnlyPropertyType =
  | "title"
  | "created_time"
  | "last_edited_time"
  | "created_by"
  | "last_edited_by"
  | "rollup"
  | "formula"
  | "unique_id"
  | "button"
  | "location"
  | "last_visited_time";

export interface PlacePropertyValue {
  lat: number;
  lon: number;
  name?: string | null;
  address?: string | null;
  aws_place_id?: string | null;
  google_place_id?: string | null;
}

export interface VerificationDateValue {
  start: string;
  end?: string | null;
  time_zone?: string | null;
}

export type VerificationPropertyValue =
  | { state: "unverified"; date?: null; verified_by?: null }
  | {
      state: "verified" | "expired";
      date?: VerificationDateValue | null;
      verified_by?: unknown;
    };

export type NotionRollupFunction =
  | "count"
  | "count_values"
  | "empty"
  | "not_empty"
  | "unique"
  | "show_unique"
  | "percent_empty"
  | "percent_not_empty"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "count_per_group"
  | "percent_per_group"
  | "show_original";

/** Read-only compatibility for rollup configs stored before the current API names. */
export type LegacyRollupFunction = "count_all" | "count_empty" | "count_unique";
export type RollupFunction = NotionRollupFunction | LegacyRollupFunction;

export interface SelectOption {
  id: string;
  name: string;
  color: string; // named color
}

export interface FileAttachment {
  id: string;
  key?: string;
  uploadId?: string;
  bucket?: string;
  name: string;
  url: string;
  type?: string;
  size?: number;
  sourceUrl?: string;
  notionFileSource?: string;
  notionFileExpiryTime?: string;
  notionFileCopied?: boolean;
}

export type FileUploadStatus = "pending" | "uploaded" | "deleting" | "deleted" | "expired";

export interface FileUpload extends Timestamped {
  workspaceId: string;
  bucket: string;
  key: string;
  scope: string;
  pageId?: string;
  blockId?: string;
  databaseId?: string;
  propertyId?: string;
  templateId?: string;
  name: string;
  contentType?: string;
  size: number;
  status: FileUploadStatus;
  url?: string;
  createdBy?: string;
  expiresAt?: string | null;
  completedAt?: string | null;
  expiredAt?: string | null;
  deletedAt?: string | null;
  deletedBy?: string;
}

export interface FileStatBucket {
  count: number;
  bytes: number;
}

export interface FileMaintenanceRun extends Timestamped {
  workspaceId: string;
  kind?: string;
  actorId?: string;
  status?: "success" | "partial_failure" | "failed" | string;
  scheduledAt?: string | null;
  startedAt?: string;
  finishedAt?: string;
  scanned?: number;
  expired?: number;
  deletedObjects?: number;
  failedObjects?: number;
  failures?: unknown;
  details?: unknown;
}

export interface FileUsageReport {
  workspaceId?: string;
  organizationId?: string;
  organizationName?: string;
  storageLimitBytes?: number | null;
  workspaceCount?: number;
  generatedAt: string;
  totals: {
    files: number;
    bytes: number;
    activeStorageBytes: number;
    uploadedBytes: number;
    pendingBytes: number;
    deletedBytes: number;
    expiredBytes: number;
  };
  pending: {
    active: number;
    expired: number;
  };
  byStatus: Record<string, FileStatBucket>;
  byScope: Record<string, FileStatBucket>;
  byContentType: Record<string, FileStatBucket>;
  largestUploads: FileUpload[];
  recentUploads: FileUpload[];
  maintenanceRuns: FileMaintenanceRun[];
  byWorkspace?: Array<{
    workspaceId: string;
    name?: string | null;
    domain?: string | null;
    totals: FileUsageReport["totals"];
    pending: FileUsageReport["pending"];
  }>;
}

export type NotificationKind = "comment" | "mention" | "link" | "page_edit" | "system";

export interface NotificationRecord extends Timestamped {
  workspaceId: string;
  userId: string;
  activityKey: string;
  kind: NotificationKind;
  pageId?: string | null;
  blockId?: string | null;
  commentId?: string | null;
  actorId?: string | null;
  title?: string;
  preview?: string;
  target?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  readAt?: string | null;
}

export interface PropertyConfig {
  options?: SelectOption[]; // select / multi_select / status
  numberFormat?: "number" | "comma" | "percent" | "dollar" | "won" | "euro";
  dateFormat?: string;
  notionType?: string;
  notionPropertyId?: string; // source Notion property id, when imported from Notion API
  notion?: {
    type?: string;
    number?: {
      format?: string | null;
    };
    date?: Record<string, unknown>;
  } & Record<string, unknown>;
  relationDatabaseId?: string;
  databaseFeatureRole?:
    | "subitem_parent"
    | "subitem_children"
    | "dependency_predecessor"
    | "dependency_successor"
    | "preserved_subitem_parent"
    | "preserved_subitem_children"
    | "preserved_dependency_predecessor"
    | "preserved_dependency_successor";
  // Two-way (Notion "Show on …") relation: the id of the paired relation
  // property on the related database. Present ⇒ two-way; absent ⇒ one-way.
  relatedPropertyId?: string;
  rollupRelationPropertyId?: string;
  rollupTargetPropertyId?: string;
  rollupFunction?: RollupFunction;
  formula?: string;
  idPrefix?: string; // unique_id property display prefix, e.g. "TASK"
  rollupVia?: string; // optional second relation hop for multi-hop rollups
  hideWhenEmpty?: boolean; // row/page property panel display option
  hideInPagePanel?: boolean; // always hide in row/page property panels unless hidden properties are expanded
  button?: DatabaseButtonActionDocument;
}

export type AutomationValueExpression =
  | { kind: "literal"; value: unknown }
  | { kind: "execution_time" }
  | { kind: "formula"; expression: string }
  | { kind: "variable"; name: string }
  | { kind: "trigger_property"; propertyId: string };

export type AutomationDynamicText = string | AutomationValueExpression;

export interface EditPropertyAutomationAction {
  id: string;
  type: "edit_property";
  target: "trigger_page";
  propertyId: string;
  value: AutomationValueExpression;
}

export interface DatabaseButtonActionDocument {
  version: 1;
  label: string;
  actions: AutomationAction[];
}

export interface InsertBlocksAutomationAction {
  id: string;
  type: "insert_blocks";
  target: "trigger_page";
  blocks: ButtonTemplateBlock[];
}

export interface AddPageAutomationAction {
  id: string;
  type: "add_page";
  target: "database";
  databaseId: string;
  title: AutomationDynamicText;
  properties?: AutomationPropertyChange[];
  openCreatedPage?: boolean;
}

export interface AutomationPropertyChange {
  propertyId: string;
  value: AutomationValueExpression;
}

export interface EditPagesAutomationAction {
  id: string;
  type: "edit_pages";
  target: {
    type: "database";
    databaseId: string;
    filter: Record<string, unknown>;
    limit: number;
  };
  changes: AutomationPropertyChange[];
}

export interface DefineVariablesAutomationAction {
  id: string;
  type: "define_variables";
  variables: Array<{ name: string; value: AutomationValueExpression }>;
}

export interface SendNotificationAutomationAction {
  id: string;
  type: "send_notification";
  recipientIds: string[];
  message: string;
}

export interface SendEmailAutomationAction {
  id: string;
  type: "send_email";
  recipientEmail: string;
  subject: string;
  message: string;
}

export interface SendWebhookAutomationAction {
  id: string;
  type: "send_webhook";
  url: string;
  body: Record<string, unknown>;
}

export interface SendSlackAutomationAction {
  id: string;
  type: "send_slack";
  connectionId: string;
  channelId: string;
  message: string;
}

export interface ShowConfirmationAutomationAction {
  id: string;
  type: "show_confirmation";
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

export interface OpenPageAutomationAction {
  id: string;
  type: "open_page";
  pageId: string;
}

export interface OpenFormAutomationAction {
  id: string;
  type: "open_form";
  databaseId: string;
  viewId: string;
}

export interface OpenUrlAutomationAction {
  id: string;
  type: "open_url";
  url: string;
}

export type AutomationAction =
  | EditPropertyAutomationAction
  | InsertBlocksAutomationAction
  | AddPageAutomationAction
  | EditPagesAutomationAction
  | DefineVariablesAutomationAction
  | SendNotificationAutomationAction
  | SendEmailAutomationAction
  | SendWebhookAutomationAction
  | SendSlackAutomationAction
  | ShowConfirmationAutomationAction
  | OpenPageAutomationAction
  | OpenFormAutomationAction
  | OpenUrlAutomationAction;

export interface PageButtonActionDocument {
  version: 1;
  label: string;
  actions: AutomationAction[];
}

export interface DatabaseAutomationDefinition {
  id: string;
  workspaceId: string;
  databaseId: string;
  name: string;
  enabled: boolean;
  scopeType: "database" | "view";
  viewId?: string | null;
  triggerType: "events" | "schedule";
  trigger: Record<string, unknown>;
  actionDocument: Record<string, unknown>;
  nextRunAt?: string | null;
  status: "active" | "disabled" | "paused";
  revision: number;
  pausedAt?: string | null;
  pausedReason?: string | null;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DbProperty extends Timestamped {
  databaseId: string;
  name: string;
  description?: string;
  type: PropertyType;
  config?: PropertyConfig;
  position: number;
}

export type ViewType =
  | "table"
  | "board"
  | "list"
  | "gallery"
  | "calendar"
  | "timeline"
  | "form"
  | "chart";

export type FormAudience = "none" | "workspace" | "web";
export type FormButtonColor = "blue" | "gray" | "green" | "red" | "orange" | "purple";

export interface FormViewQuestion {
  id: string;
  propertyId: string;
  label: string;
  description: string;
  required: boolean;
  hidden: boolean;
  syncWithPropertyName: boolean;
  longAnswer?: boolean;
  optionsDisplay?: "list" | "dropdown";
  maxSelections?: number;
  position: number;
}

export interface FormViewSubmitConfig {
  buttonLabel: string;
  confirmationTitle: string;
  confirmationBody: string;
  buttonColor: FormButtonColor;
}

export interface FormViewConfig {
  version: 1;
  title: string;
  description: string;
  icon: string;
  cover: string;
  questions: FormViewQuestion[];
  submit: FormViewSubmitConfig;
}

export interface FormLink extends Timestamped {
  workspaceId: string;
  databaseId: string;
  viewId: string;
  token: string;
  audience: FormAudience;
  enabled: boolean;
  createdBy?: string;
}

export interface FormPublicProperty {
  id: string;
  name: string;
  description?: string;
  type: PropertyType;
  config?: Pick<PropertyConfig, "options">;
}

export interface FormReferenceOption {
  id: string;
  name: string;
  avatar?: string | null;
}

export interface FormOptionsResult {
  propertyId: string;
  type: "person" | "relation";
  options: FormReferenceOption[];
  hasMore: boolean;
  after: string | null;
}

export interface FormDefinitionResult {
  form: FormViewConfig;
  properties: FormPublicProperty[];
  revision: string;
}

export interface FormSubmitResult {
  rowId: string;
  replayed: boolean;
  confirmation: FormViewSubmitConfig;
}

export type FilterOperator =
  | "equals"
  | "does_not_equal"
  | "contains"
  | "does_not_contain"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "less_than"
  | "on_or_before"
  | "on_or_after";

export interface ViewFilter {
  propertyId: string;
  operator: FilterOperator;
  value?: unknown;
}

/**
 * Recursive filter tree for nested AND/OR groups. `filters` are leaf conditions
 * combined by `conjunction`; `groups` are nested sub-groups combined the same way.
 */
export interface FilterGroup {
  conjunction: "and" | "or";
  filters: ViewFilter[];
  groups?: FilterGroup[];
}

export interface ViewSort {
  propertyId: string;
  direction: "asc" | "desc";
}

export type TableCalculation =
  | "count_all"
  | "count_values"
  | "count_unique"
  | "count_empty"
  | "percent_empty"
  | "percent_not_empty"
  | "checked"
  | "unchecked"
  | "percent_checked"
  | "percent_unchecked"
  | "sum"
  | "average"
  | "median"
  | "min"
  | "max"
  | "range"
  | "earliest_date"
  | "latest_date"
  | "date_range";

export interface DatabaseSubtaskViewConfig {
  displayMode: "show" | "hidden" | "flattened" | "disabled";
  filterScope: "parents" | "parents_and_subitems" | "subitems";
  propertyId: string;
  toggleColumnId: string;
}

export interface ViewConfig {
  type?: ViewType;
  visibleProperties?: string[];
  hiddenProperties?: string[];
  propertyOrder?: string[];
  rowPagePropertyOrder?: string[]; // row peek/full-page property panel order, separate from table column order
  propertyWidths?: Record<string, number>;
  tableCalculations?: Record<string, TableCalculation>;
  subtasks?: DatabaseSubtaskViewConfig;
  search?: string;
  filters?: ViewFilter[];
  filterConjunction?: "and" | "or";
  filterGroup?: FilterGroup; // nested AND/OR filter tree (supersedes flat filters when set)
  quickFilters?: Array<ViewFilter | FilterGroup>; // legacy import compatibility; normalize into filterGroup
  sorts?: ViewSort[];
  wrappedColumns?: string[]; // property ids whose table cells wrap text
  groupBy?: string; // propertyId
  calendarBy?: string; // date property id
  timelineBy?: string; // start date property id
  timelineEndBy?: string; // optional end date property id
  timelineZoom?: "day" | "week" | "month"; // timeline scale
  timelineShowTable?: boolean; // timeline left table/list rail
  timelineLoadLimit?: number; // timeline visible project limit
  dependencyProperty?: string; // relation property holding each row's predecessor rows (timeline arrows)
  wrap?: boolean;
  fitImage?: boolean; // card previews contain image instead of cropping
  calendarLayout?: "month" | "week";
  cardSize?: "small" | "medium" | "large";
  coverProperty?: string;
  openPageIn?: "side" | "center" | "full"; // how a row opens (peek / modal / full page)
  rowHeight?: "short" | "medium" | "tall"; // table row density
  initialLoadLimit?: number; // table first row batch size
  subGroupBy?: string; // second-level grouping (board)
  chartType?: "bar" | "horizontal_bar" | "line" | "donut"; // chart view layout
  chartGroupBy?: string; // chart x-axis / grouping property id
  chartAggregate?: NotionChartAggregate; // chart y-axis aggregation
  chartAggregateBy?: string; // compatible property id aggregated for non-count chart aggregations
  notionViewId?: string; // source Notion view id, when imported from Notion API
  notionType?: string; // original Notion view type, when imported from Notion API
  notionChromeCreatedTime?: string; // peer-created time used only for imported linked DB tab ordering
  viewTabOrderEditedAt?: string; // user reordered database view tabs; prefer saved positions over imported chrome order
  inlineDatabaseBlockId?: string; // block-scoped inline/linked database view owner
  inlineDatabaseSourceViewId?: string; // source view cloned when creating a block-scoped inline view
  unsupportedNotionViewType?: string; // original Notion view type that needs a fallback renderer
  notion?: Record<string, unknown>; // raw source Notion view metadata used for linked database scoping
  notionFilter?: unknown;
  notionSorts?: unknown;
  notionVisibleProperties?: unknown;
  notionHiddenProperties?: unknown;
  notionPropertyOrder?: unknown;
  notionPropertySettings?: unknown;
  notionQuickFilters?: unknown;
  unresolvedPropertyReferences?: unknown[];
  templateLinkedView?: boolean;
  templateLinkedSourceDatabaseId?: string;
  templateLinkedRelationPropertyId?: string;
  hanjiForm?: FormViewConfig;
  /** Display snapshot only; `form_links` remains the server authority. */
  hanjiFormAudience?: FormAudience;
}

export interface DbView extends Timestamped {
  databaseId: string;
  name: string;
  type: ViewType;
  config?: ViewConfig;
  position: number;
}

export interface DbTemplate extends Timestamped {
  databaseId: string;
  name: string;
  icon?: string;
  title?: string;
  properties?: Record<string, unknown>;
  blocks?: ButtonTemplateBlock[];
  isDefault?: boolean;
  position: number;
}

export interface Comment extends Timestamped {
  pageId: string;
  blockId?: string | null;
  parentId?: string | null;
  authorId: string;
  body?: unknown;
  resolved?: boolean;
  /** Set only when the BODY is edited (resolve/move also bump updatedAt). */
  editedAt?: string;
}

export type ShareRole = "view" | "comment" | "edit" | "full_access";
export type SharePrincipalType = "user" | "email" | "group" | "integration";
export type WorkspaceCreationPolicy = "owners_admins" | "members";
export type SignupPolicy = "public" | "closed";
export type MemberAddPolicy = "enabled" | "disabled";
export type DomainSignupPolicy = "invite_only" | "verified_domains";
export type OrganizationMemberRole =
  | "owner"
  | "admin"
  | "security_admin"
  | "billing_admin"
  | "member"
  | "guest";
export type OrganizationSharingPolicyKey =
  | "publicWebSharing"
  | "externalEmailSharing"
  | "guestAccess"
  | "fileDownloads"
  | "fullAccessGrants";
export type OrganizationSharingPolicy = Partial<Record<OrganizationSharingPolicyKey, boolean>>;

export interface WorkspaceMember extends Timestamped {
  workspaceId: string;
  userId: string;
  displayName?: string;
  email?: string;
  avatar?: string | null;
  role: "owner" | "admin" | "member" | "guest" | string;
  createdBy?: string;
}

export interface Organization extends Timestamped {
  name: string;
  icon?: string | null;
  ownerId?: string;
  workspaceCreationPolicy?: WorkspaceCreationPolicy | string;
  domainSignupPolicy?: DomainSignupPolicy | string;
  sharingPolicy?: OrganizationSharingPolicy | Record<string, unknown> | null;
  storageLimitBytes?: number | null;
}

export interface InstanceSettings extends Timestamped {
  signupPolicy?: SignupPolicy | string;
  memberAddPolicy?: MemberAddPolicy | string;
  instanceAdminUserIds?: string[] | unknown;
  updatedBy?: string | null;
}

export interface InstanceAdminUser {
  id: string;
  email?: string | null;
  displayName?: string | null;
  role?: string | null;
  status?: string | null;
  disabled?: boolean;
  verified?: boolean;
  isAnonymous?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastLoginAt?: string | null;
  workspaceCount: number;
  organizationCount: number;
  activeOrganizationCount: number;
  deactivatedOrganizationCount: number;
  isInstanceAdmin: boolean;
}

export interface ServerWorkspaceSummary {
  id: string;
  name?: string | null;
  domain?: string | null;
  ownerId?: string | null;
  organizationId?: string | null;
  memberCount: number;
  pageCount: number;
  databaseCount: number;
  fileCount: number;
  activeStorageBytes: number;
  importJobCount: number;
  failedImportJobCount: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ServerAuditSummaryEvent {
  id: string;
  scope: "instance" | "organization";
  organizationId?: string | null;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface ServerImportJobSummary {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  status: string;
  phase: string;
  actorId?: string | null;
  notionWorkspaceName?: string | null;
  itemCount: number;
  failedItemCount: number;
  mappedItemCount: number;
  error?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export interface ServerUsageSummary {
  totals: {
    files: number;
    activeStorageBytes: number;
    uploadedBytes: number;
    pendingBytes: number;
    deletedBytes: number;
    expiredBytes: number;
  };
  pending: {
    active: number;
    expired: number;
  };
  byWorkspace: Array<{
    workspaceId: string;
    workspaceName?: string | null;
    files: number;
    activeStorageBytes: number;
  }>;
  recentMaintenanceRuns: Array<{
    id: string;
    workspaceId: string;
    workspaceName?: string | null;
    kind?: string | null;
    status?: string | null;
    scanned?: number;
    expired?: number;
    failedObjects?: number;
    startedAt?: string | null;
  }>;
}

export interface ServerOverviewSummary {
  generatedAt: string;
  counts: {
    users: number;
    activeUsers: number;
    disabledUsers: number;
    verifiedUsers: number;
    instanceAdmins: number;
    organizations: number;
    workspaces: number;
    pages: number;
    databases: number;
    importJobs: number;
    failedImportJobs: number;
    files: number;
    activeStorageBytes: number;
  };
  health: Array<{
    key: string;
    label: string;
    status: "ok" | "attention" | "missing";
    detail: string;
  }>;
}

export interface ServerSecuritySummary {
  sessionRevocationAvailable: boolean;
  mfaResetAvailable: boolean;
  passwordResetAvailable: boolean;
  disabledUsers: number;
  instanceAdmins: number;
  notes: string[];
}

export interface ServerBackupSummary {
  generatedAt: string;
  restoreAvailable: boolean;
  downloadableTables: string[];
  tableCounts: Record<string, number>;
  notes: string[];
}

export interface ServerSystemSummary {
  generatedAt: string;
  environment: Array<{
    key: string;
    label: string;
    configured: boolean;
    detail: string;
  }>;
}

export interface InstanceBackupSnapshot {
  generatedAt: string;
  tableCounts: Record<string, number>;
  tables: Record<string, unknown[]>;
  notes: string[];
}

export interface OrganizationMember extends Timestamped {
  organizationId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  role: OrganizationMemberRole | string;
  status?: "active" | "deactivated" | string;
  createdBy?: string;
  deactivatedAt?: string | null;
  deactivatedBy?: string | null;
}

export interface OrganizationProfileWorkspaceMembership {
  workspaceId: string;
  workspaceName: string;
  workspaceDomain?: string | null;
  workspaceMemberId: string;
  role: WorkspaceMember["role"];
}

export interface OrganizationProfilePendingInvitation {
  workspaceId: string;
  workspaceName: string;
  workspaceDomain?: string | null;
  invitationId: string;
  email: string;
  role: WorkspaceMember["role"];
  status: string;
}

export interface OrganizationProfile {
  organizationMemberId?: string | null;
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  avatar?: string | null;
  organizationRole: OrganizationMember["role"];
  status: OrganizationMember["status"] | "invited" | string;
  workspaceMemberships: OrganizationProfileWorkspaceMembership[];
  pendingInvitations: OrganizationProfilePendingInvitation[];
}

export interface OrganizationGroupMember extends Timestamped {
  organizationId?: string;
  groupId?: string;
  organizationMemberId: string;
  userId: string;
  displayName?: string | null;
  email?: string | null;
  role: OrganizationMember["role"];
  status: OrganizationMember["status"] | string;
}

export interface OrganizationGroup extends Timestamped {
  organizationId: string;
  name: string;
  description?: string | null;
  createdBy?: string;
  members: OrganizationGroupMember[];
}

export interface OrganizationDomain extends Timestamped {
  organizationId: string;
  domain: string;
  status?: "pending" | "verified" | "rejected" | string;
  verificationMethod?: "dns_txt" | string;
  verificationToken?: string | null;
  verificationCheckedAt?: string | null;
  verificationError?: string | null;
  recordName?: string | null;
  recordValue?: string | null;
  createdBy?: string;
  verifiedAt?: string | null;
  verifiedBy?: string | null;
}

export interface OrganizationAuditEvent extends Timestamped {
  organizationId: string;
  workspaceId?: string | null;
  actorId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown> | null;
  occurredAt: string;
}

export interface OrganizationEnterpriseControls extends Timestamped {
  organizationId: string;
  ssoConfig?: Record<string, unknown> | null;
  scimConfig?: Record<string, unknown> | null;
  auditPolicy?: Record<string, unknown> | null;
  dataResidencyPolicy?: Record<string, unknown> | null;
  dlpPolicy?: Record<string, unknown> | null;
  legalPolicy?: Record<string, unknown> | null;
  billingProfile?: Record<string, unknown> | null;
  mcpGovernancePolicy?: OrganizationMcpGovernancePolicy | null;
  updatedBy?: string | null;
}

export interface OrganizationApprovedMcpClient {
  clientId: string;
  name: string;
  approvedAt: string;
  approvedBy: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface OrganizationMcpWorkspacePolicy {
  workspaceId: string;
  enabled: boolean;
  approvedClients: OrganizationApprovedMcpClient[];
  updatedAt?: string | null;
  updatedBy?: string | null;
}

export interface OrganizationMcpGovernancePolicy {
  workspacePolicies: OrganizationMcpWorkspacePolicy[];
}

export interface OrganizationScimToken extends Timestamped {
  organizationId: string;
  label: string;
  status?: "active" | "revoked" | "expired" | string;
  tokenPrefix?: string | null;
  scopes?: Record<string, unknown> | null;
  createdBy?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
}

export type NotionAdminCapability =
  | "legal-hold:read"
  | "legal-hold:write"
  | "legal-hold:write-high-impact"
  | "legal-hold:export"
  | "workspace:export"
  | "managed-user-session:write";

export interface OrganizationAdminToken extends Timestamped {
  organizationId: string;
  label: string;
  status?: "active" | "revoked" | "expired" | string;
  tokenPrefix?: string | null;
  scopes?: {
    version?: number;
    capabilities?: NotionAdminCapability[];
    resources?: {
      organizationId?: string;
      workspaceIds?: string[];
      legalHoldIds?: string[];
    };
  } | null;
  createdBy?: string | null;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  revokedBy?: string | null;
}

export interface OrganizationLegalHold extends Timestamped {
  organizationId: string;
  name: string;
  status?: "active" | "released" | string;
  reason?: string | null;
  scope?: Record<string, unknown> | null;
  createdBy?: string | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
}

export interface OrganizationAuditExport extends Timestamped {
  organizationId: string;
  status?: "completed" | "failed" | string;
  format?: "jsonl" | "csv" | "json" | string;
  filter?: Record<string, unknown> | null;
  eventCount?: number;
  content?: string | null;
  createdBy?: string | null;
  completedAt?: string | null;
}

export interface OrganizationDiscoveryExport extends Timestamped {
  organizationId: string;
  status?: "completed" | "failed" | string;
  format?: "jsonl" | "json" | string;
  filter?: Record<string, unknown> | null;
  itemCount?: number;
  content?: string | null;
  createdBy?: string | null;
  completedAt?: string | null;
}

export interface OrganizationBillingRecord extends Timestamped {
  organizationId: string;
  externalId?: string | null;
  kind?: "contract" | "subscription" | "invoice" | "credit" | string;
  status?: string;
  title: string;
  amountCents?: number | null;
  currency?: string | null;
  billingEmail?: string | null;
  contractOwnerEmail?: string | null;
  renewalAt?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  metadata?: Record<string, unknown> | null;
  createdBy?: string | null;
}

export interface WorkspaceInvitation extends Timestamped {
  workspaceId: string;
  email: string;
  displayName?: string | null;
  role: "admin" | "member" | "guest" | string;
  token: string;
  status?: "pending" | "accepted" | "revoked" | "expired" | string;
  emailDeliveryStatus?: "unsent" | "sent" | "failed" | "not_configured" | string;
  emailMessageId?: string | null;
  emailDeliveredAt?: string | null;
  emailDeliveryError?: string | null;
  createdBy?: string;
  acceptedBy?: string;
  acceptedAt?: string;
  expiresAt?: string;
}

export interface PagePermission extends Timestamped {
  pageId: string;
  workspaceId: string;
  principalType: SharePrincipalType;
  principalId?: string;
  label: string;
  role: ShareRole;
  createdBy?: string;
}

export interface ShareLink extends Timestamped {
  pageId: string;
  workspaceId: string;
  token: string;
  enabled: boolean;
  role: ShareRole;
  expiresAt?: string | null;
  createdBy?: string;
}

export type SiteTheme = "system" | "light" | "dark";
export type SiteDomainStatus = "none" | "pending_validation" | "validated";

export interface SiteConfig extends Timestamped {
  pageId: string;
  workspaceId?: string;
  slug: string;
  published: boolean;
  title: string;
  description?: string;
  theme: SiteTheme;
  showBreadcrumbs: boolean;
  showSearch: boolean;
  showBranding: boolean;
  navigationPageIds: string[];
  customHostname?: string | null;
  domainStatus?: SiteDomainStatus;
  domainVerificationToken?: string | null;
  revision: number;
}

// Convenience: a text-bearing block's plain text from its rich spans.
export function spansToPlainText(spans?: TextSpan[]): string {
  return (spans ?? []).map((s) => s.text).join("");
}
