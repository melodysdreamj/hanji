import { DATABASE_PROPERTY_TYPES } from './database-property-types';
import { NOTION_DATABASE_VIEW_TYPES } from './database-view-types';
import type {
  ImportConversionReport,
  NotionImportWarning,
} from './notion-import-contracts';

export const SUPPORTED_NOTION_PROPERTY_TYPES = new Set<string>([
  ...DATABASE_PROPERTY_TYPES,
  'people',
  'phone_number',
]);

export const SUPPORTED_NOTION_VIEW_TYPES = new Set<string>(NOTION_DATABASE_VIEW_TYPES);

export function emptyConversionReport(): ImportConversionReport {
  return {
    summary: {},
    warnings: [],
    unsupported: [],
    missingPermissions: [],
    unresolvedReferences: [],
  };
}

export function incrementReport(report: ImportConversionReport, key: string, by = 1) {
  report.summary[key] = (report.summary[key] ?? 0) + by;
}

export function pushReportIssue(
  list: NotionImportWarning[],
  issue: NotionImportWarning,
  maxItems = 200,
) {
  if (list.length < maxItems) list.push(issue);
}

export function reportUnresolvedFormulaPropertyReference(
  report: ImportConversionReport,
  dataSourceId: string,
  notionPropertyId: string | undefined,
  formulaPropertyName: string,
  referencedProperty: string,
) {
  incrementReport(report, 'unresolvedFormulaPropertyReferences');
  pushReportIssue(report.unresolvedReferences, {
    code: 'formula_property_unresolved',
    notionId: notionPropertyId ?? dataSourceId,
    notionObject: 'property',
    message:
      `Formula property "${formulaPropertyName}" references unknown Notion property "${referencedProperty}" ` +
      `in data source ${dataSourceId}. The original formula was preserved, but that property reference could not be remapped.`,
  });
}

export function reportUnsupportedFormulaFunctions(
  report: ImportConversionReport,
  dataSourceId: string,
  notionPropertyId: string | undefined,
  formulaPropertyName: string,
  unsupportedFunctions: string[],
) {
  if (unsupportedFunctions.length === 0) return;
  incrementReport(report, 'unsupportedFormulaFunctions', unsupportedFunctions.length);
  pushReportIssue(report.unsupported, {
    code: 'formula_function_unsupported',
    notionId: notionPropertyId ?? dataSourceId,
    notionObject: 'property',
    message:
      `Formula property "${formulaPropertyName}" uses unsupported function(s): ${unsupportedFunctions.join(', ')}. ` +
      'The original formula and Notion-computed cell values were preserved for fallback.',
  });
}

export function reportUnsupportedProperty(
  report: ImportConversionReport,
  dataSourceId: string,
  propertyId: string,
  propertyName: string,
  notionType: string,
) {
  if (SUPPORTED_NOTION_PROPERTY_TYPES.has(notionType.trim().toLowerCase())) return;
  incrementReport(report, 'unsupportedProperties');
  pushReportIssue(report.unsupported, {
    code: 'unsupported_property_type',
    notionId: propertyId,
    notionObject: 'property',
    message: `Property "${propertyName}" from data source ${dataSourceId} uses unsupported Notion type "${notionType}" and was imported as rich text fallback.`,
  });
}

function notionObjectId(record: Record<string, unknown>) {
  return typeof record.id === 'string' && record.id.trim() ? record.id.trim() : undefined;
}

export function reportUnsupportedView(
  report: ImportConversionReport,
  dataSourceId: string,
  view: Record<string, unknown>,
) {
  const type = typeof view.type === 'string' ? view.type.trim().toLowerCase() : '';
  if (SUPPORTED_NOTION_VIEW_TYPES.has(type)) return;
  incrementReport(report, 'unsupportedViews');
  pushReportIssue(report.unsupported, {
    code: 'unsupported_view_type',
    notionId: notionObjectId(view) ?? dataSourceId,
    notionObject: 'view',
    message: `View "${typeof view.name === 'string' ? view.name : 'Untitled'}" uses unsupported Notion type "${type || 'unknown'}" and was imported with a fallback renderer.`,
  });
}

export function mergeImportReportEntries(previous: unknown, current: unknown, limit = 500) {
  const merged = [
    ...(Array.isArray(previous) ? previous : []),
    ...(Array.isArray(current) ? current : []),
  ];
  const seen = new Set<string>();
  const result: unknown[] = [];
  for (const entry of merged) {
    let key: string;
    try {
      key = JSON.stringify(entry);
    } catch {
      key = String(entry);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

export function finalizeConversionReport(report: ImportConversionReport) {
  return {
    ...report,
    summary: {
      ...report.summary,
      warnings: report.warnings.length,
      unsupported: report.unsupported.length,
      missingPermissions: report.missingPermissions.length,
      unresolvedReferences: report.unresolvedReferences.length,
    },
  };
}
