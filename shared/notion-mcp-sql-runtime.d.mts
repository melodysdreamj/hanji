export interface NotionMcpSqlPart {
  select: string;
  selectItems: Array<Record<string, unknown>>;
  distinct: boolean;
  dataSourceUrl: string;
  where?: string;
  whereAst?: Record<string, unknown>;
  groupBy: string[];
  groupByAst: Array<Record<string, unknown>>;
  having?: string;
  havingAst?: Record<string, unknown>;
  orderBy?: string;
  orderDirection: 'asc' | 'desc';
  orderKeys: Array<{
    expression: Record<string, unknown>;
    direction: 'asc' | 'desc';
  }>;
  limit?: number;
  offset: number;
  parameterCount: number;
  nodeCount: number;
  query?: Record<string, unknown>;
  dataSourceUrls?: string[];
}

export interface NotionMcpSqlCursorMetadata {
  eligible: boolean;
  limit?: number;
  offset: number;
}

export interface ParsedNotionMcpSql {
  /**
   * Permission-discovery descriptors. Every physical collection:// reference,
   * including references nested in CTEs and subqueries, appears here.
   */
  parts: NotionMcpSqlPart[];
  /** Root compound SELECT descriptors; execution uses the bounded `query` AST. */
  queryParts: NotionMcpSqlPart[];
  operators: Array<'all' | 'distinct'>;
  query: Record<string, unknown>;
  /** Ordered, de-duplicated physical collection:// references for allowlist checks. */
  dataSourceUrls: string[];
  nodeCount: number;
  parameterCount: number;
  hasSingleResultSet: boolean;
  cursor: NotionMcpSqlCursorMetadata;
}

export interface NotionMcpSqlStreamPlan {
  sourceUrl: string;
  orderBy: Array<{
    property: string;
    direction: 'asc' | 'desc';
  }>;
}

export const NOTION_MCP_SQL_LIMITS: Readonly<{
  maxSqlBytes: number;
  maxParams: number;
  maxDepth: number;
  maxNodes: number;
  maxOutputRows: number;
  maxSources: number;
  maxSelectParts: number;
  maxSelectStatements: number;
  maxCtes: number;
  maxJoins: number;
  maxSubqueries: number;
  maxIntermediateRows: number;
  maxJoinRows: number;
  maxWorkUnits: number;
}>;

export function parseNotionMcpSqlPart(query: string): NotionMcpSqlPart;
export function parseNotionMcpSqlUnion(query: unknown): ParsedNotionMcpSql;
export const parseDataSourceSqlQuery: typeof parseNotionMcpSqlPart;
export const parseDataSourceSqlUnionQuery: typeof parseNotionMcpSqlUnion;
export function executeNotionMcpSql(
  parsed: ParsedNotionMcpSql,
  params: unknown[],
  tables: Map<string, Array<Record<string, unknown>>>,
): { results: Array<Record<string, unknown>>; hasMore: boolean };
export function canStreamNotionMcpSql(parsed: ParsedNotionMcpSql): boolean;
export const NOTION_MCP_SQL_CROSS_WINDOW_ERROR: string;
export function notionMcpSqlStreamPlan(parsed: ParsedNotionMcpSql): NotionMcpSqlStreamPlan | null;
export function executeStreamableNotionMcpSqlChunk(
  parsed: ParsedNotionMcpSql,
  params: unknown[],
  sourceUrl: string,
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>>;
export function applySimpleSqlWhere(
  rows: Array<Record<string, unknown>>,
  whereClause: string | undefined,
  params?: unknown[],
): Array<Record<string, unknown>>;
export function countSqlBindParameters(value: string | undefined): number;
export function sqlCountProjectionAlias(select: string): string | null;
export function selectSqlColumns(
  rows: Array<Record<string, unknown>>,
  select: string,
): Array<Record<string, unknown>>;
