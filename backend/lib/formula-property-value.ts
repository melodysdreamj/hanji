import type {
  FormulaReference,
  FormulaValue,
} from '../../shared/database/formula-core';

export type FormulaProperty = {
  id: string;
  name?: string;
  type: string;
  config?: {
    options?: Array<{ id?: string; name?: string }>;
  } & Record<string, unknown>;
};

export type FormulaPage = {
  id?: string;
  title?: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  createdBy?: string;
  lastEditedBy?: string;
};

function rawPropertyValue(row: FormulaPage, property: FormulaProperty) {
  if (property.type === 'title') return row.title;
  if (property.type === 'created_time') return row.createdAt;
  if (property.type === 'last_edited_time') return row.updatedAt;
  if (property.type === 'created_by') return row.createdBy;
  if (property.type === 'last_edited_by') return row.lastEditedBy;
  return row.properties?.[property.id];
}

function values(value: unknown) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function optionName(property: FormulaProperty, value: unknown) {
  const id = String(value ?? '');
  const option = property.config?.options?.find((candidate) => (
    candidate.id === id || candidate.name === id
  ));
  return option?.name ?? id;
}

function reference(kind: FormulaReference['kind'], id: string, name: string): FormulaReference {
  return { kind, id, name: name || id };
}

function personIdentity(value: unknown) {
  if (typeof value === 'string') return { id: value.trim(), name: '' };
  if (!value || typeof value !== 'object') return { id: '', name: '' };
  const item = value as Record<string, unknown>;
  const notion = item.notion && typeof item.notion === 'object'
    ? item.notion as Record<string, unknown>
    : undefined;
  const id = item.id ?? item.userId;
  const name = item.name ?? item.displayName ?? notion?.name;
  return {
    id: typeof id === 'string' ? id.trim() : '',
    name: typeof name === 'string' ? name.trim() : '',
  };
}

export function formulaPropertyValue(
  row: FormulaPage,
  property: FormulaProperty,
  pagesById: ReadonlyMap<string, FormulaPage> = new Map(),
): FormulaValue {
  const value = rawPropertyValue(row, property);
  if (value == null) return '';
  if (property.type === 'number') return Number.isFinite(Number(value)) ? Number(value) : 0;
  if (property.type === 'checkbox') return value === true;
  if (property.type === 'select' || property.type === 'status') return optionName(property, value);
  if (property.type === 'multi_select') {
    return Array.from(new Set(values(value).map((item) => optionName(property, item)).filter(Boolean)));
  }
  if (property.type === 'relation') {
    return values(value).flatMap((item) => {
      const id = String(item ?? '').trim();
      const page = id ? pagesById.get(id) : undefined;
      return page ? [reference('page', id, page.title?.trim() || 'Untitled')] : [];
    });
  }
  if (property.type === 'person' || property.type === 'created_by' || property.type === 'last_edited_by') {
    const unique = new Map<string, FormulaReference>();
    for (const item of values(value)) {
      const identity = personIdentity(item);
      if (!identity.id) continue;
      unique.set(identity.id, reference('person', identity.id, identity.name || identity.id));
    }
    return Array.from(unique.values());
  }
  if (property.type === 'date') {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const item = value as { start?: unknown; end?: unknown };
      if (typeof item.start === 'string' && typeof item.end === 'string' && item.end) {
        return `${item.start}/${item.end}`;
      }
      return typeof item.start === 'string' ? item.start : '';
    }
  }
  if (property.type === 'formula' || property.type === 'rollup') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value);
}
