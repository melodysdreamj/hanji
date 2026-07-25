export type NotionMcpDatabaseType = 'tasks' | 'projects' | 'skills';

export interface NotionMcpSqlProperty {
  name: string;
  type: string;
  description?: string;
  options?: Array<{ name: string; color: string }>;
  numberFormat?: string;
  formula?: string;
  relationDataSourceId?: string;
  relationDual?: {
    syncedPropertyName?: string;
    syncedPropertyId?: string;
  };
  rollupRelationPropertyId?: string;
  rollupTargetPropertyId?: string;
  rollupFunction?: string;
  uniqueIdPrefix?: string;
}

export type NotionMcpDdlOperation =
  | { action: 'add'; property: NotionMcpSqlProperty; raw: string }
  | { action: 'drop'; name: string; raw: string }
  | { action: 'rename'; from: string; to: string; raw: string }
  | { action: 'alter'; name: string; property: NotionMcpSqlProperty; raw: string };

const NOTION_OPTION_COLORS = new Set([
  'default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red',
]);

const NOTION_NUMBER_FORMATS = new Set([
  'number', 'number_with_commas', 'percent', 'dollar', 'canadian_dollar', 'singapore_dollar',
  'euro', 'pound', 'yen', 'ruble', 'rupee', 'won', 'yuan', 'real', 'lira', 'rupiah',
  'franc', 'hong_kong_dollar', 'new_zealand_dollar', 'krona', 'norwegian_krone',
  'mexican_peso', 'rand', 'new_taiwan_dollar', 'danish_krone', 'zloty', 'baht',
  'forint', 'koruna', 'shekel', 'chilean_peso', 'philippine_peso', 'dirham',
  'colombian_peso', 'riyal', 'ringgit', 'leu', 'argentine_peso', 'uruguayan_peso',
  'peruvian_sol',
]);

function splitTopLevel(input: string, separator = ',') {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quote) {
      current += character;
      if (character === quote && input[index - 1] !== '\\') quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (depth < 0) throw new Error('SQL parentheses are not balanced.');
    if (character === separator && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  if (quote) throw new Error('SQL quoted value is not terminated.');
  if (depth !== 0) throw new Error('SQL parentheses are not balanced.');
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function unquoteSqlString(value: string, label: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^'((?:[^']|'')*)'$/s) ?? trimmed.match(/^"((?:[^"]|"")*)"$/s);
  if (!match) throw new Error(`${label} must be quoted.`);
  return match[1].replace(trimmed.startsWith("'") ? /''/g : /""/g, trimmed[0]);
}

function quotedArguments(value: string, label: string) {
  return splitTopLevel(value).map((item) => unquoteSqlString(item, label));
}

function parseDescription(spec: string) {
  const match = spec.match(/\bCOMMENT\s+('(?:[^']|'')*'|"(?:[^"]|"")*")\s*$/i);
  if (!match) return { typeSpec: spec.trim(), description: undefined };
  return {
    typeSpec: spec.slice(0, match.index).trim(),
    description: unquoteSqlString(match[1], 'COMMENT'),
  };
}

function parseOptions(body: string) {
  return splitTopLevel(body).map((entry, index) => {
    const match = entry.match(/^('(?:[^']|'')*'|"(?:[^"]|"")*")(?:\s*:\s*([a-z_]+))?$/i);
    if (!match) throw new Error(`Could not parse option ${index + 1}: ${entry}`);
    const color = (match[2] ?? 'default').toLowerCase();
    if (!NOTION_OPTION_COLORS.has(color)) throw new Error(`Unsupported option color: ${color}.`);
    return { name: unquoteSqlString(match[1], 'Option name'), color };
  });
}

export function parseNotionMcpSqlProperty(typeInput: string, name: string): NotionMcpSqlProperty {
  const { typeSpec, description } = parseDescription(typeInput);
  const upper = typeSpec.toUpperCase();
  const base = { name, ...(description !== undefined ? { description } : {}) };
  const simple: Array<[RegExp, string]> = [
    [/^TITLE$/, 'title'],
    [/^(?:RICH_TEXT|TEXT)$/, 'rich_text'],
    [/^DATE$/, 'date'],
    [/^(?:PEOPLE|PERSON)$/, 'people'],
    [/^CHECKBOX$/, 'checkbox'],
    [/^URL$/, 'url'],
    [/^EMAIL$/, 'email'],
    [/^(?:PHONE_NUMBER|PHONE)$/, 'phone_number'],
    [/^FILES?$/, 'files'],
    [/^CREATED_TIME$/, 'created_time'],
    [/^LAST_EDITED_TIME$/, 'last_edited_time'],
    [/^CREATED_BY$/, 'created_by'],
    [/^LAST_EDITED_BY$/, 'last_edited_by'],
    [/^PLACE$/, 'place'],
  ];
  for (const [pattern, type] of simple) if (pattern.test(upper)) return { ...base, type };

  let match = typeSpec.match(/^(SELECT|MULTI_SELECT|STATUS)\s*\((.*)\)$/is);
  if (match) {
    const type = match[1].toLowerCase();
    return { ...base, type, options: parseOptions(match[2]) };
  }
  if (/^STATUS$/i.test(typeSpec)) return { ...base, type: 'status', options: [] };

  match = typeSpec.match(/^NUMBER(?:\s+FORMAT\s+('(?:[^']|'')*'|"(?:[^"]|"")*"))?$/is);
  if (match) {
    const numberFormat = match[1] ? unquoteSqlString(match[1], 'NUMBER FORMAT') : 'number';
    if (!NOTION_NUMBER_FORMATS.has(numberFormat)) throw new Error(`Unsupported NUMBER FORMAT: ${numberFormat}.`);
    return { ...base, type: 'number', numberFormat };
  }

  match = typeSpec.match(/^FORMULA\s*\((.*)\)$/is);
  if (match) return { ...base, type: 'formula', formula: unquoteSqlString(match[1], 'FORMULA expression') };

  match = typeSpec.match(/^RELATION\s*\((.*)\)$/is);
  if (match) {
    const args = splitTopLevel(match[1]);
    if (args.length < 1 || args.length > 2) throw new Error('RELATION requires a data source id and optional DUAL clause.');
    const relationDataSourceId = unquoteSqlString(args[0], 'RELATION data source id')
      .replace(/^collection:\/\//i, '');
    const relation: NotionMcpSqlProperty = { ...base, type: 'relation', relationDataSourceId };
    if (args[1]) {
      const dual = args[1].match(/^DUAL(?:\s+('(?:[^']|'')*'|"(?:[^"]|"")*"))?(?:\s+('(?:[^']|'')*'|"(?:[^"]|"")*"))?$/is);
      if (!dual) throw new Error(`Could not parse RELATION DUAL clause: ${args[1]}`);
      relation.relationDual = {
        ...(dual[1] ? { syncedPropertyName: unquoteSqlString(dual[1], 'DUAL synced property name') } : {}),
        ...(dual[2] ? { syncedPropertyId: unquoteSqlString(dual[2], 'DUAL synced property id') } : {}),
      };
    }
    return relation;
  }

  match = typeSpec.match(/^ROLLUP\s*\((.*)\)$/is);
  if (match) {
    const args = quotedArguments(match[1], 'ROLLUP argument');
    if (args.length !== 3) throw new Error('ROLLUP requires relation property, target property, and function.');
    return {
      ...base,
      type: 'rollup',
      rollupRelationPropertyId: args[0],
      rollupTargetPropertyId: args[1],
      rollupFunction: args[2],
    };
  }

  match = typeSpec.match(/^UNIQUE_ID(?:\s+PREFIX\s+('(?:[^']|'')*'|"(?:[^"]|"")*"))?$/is);
  if (match) {
    return {
      ...base,
      type: 'unique_id',
      uniqueIdPrefix: match[1] ? unquoteSqlString(match[1], 'UNIQUE_ID PREFIX') : '',
    };
  }

  throw new Error(`Unsupported Notion database column type: ${typeSpec}.`);
}

export function parseNotionMcpCreateTable(schema: unknown) {
  if (typeof schema !== 'string' || !schema.trim()) throw new Error('schema must be a CREATE TABLE (...) statement.');
  const body = schema.match(/^\s*CREATE\s+TABLE(?:\s+(?:"[^"]+"|[^\s(]+))?\s*\((.*)\)\s*;?\s*$/is)?.[1];
  if (!body) throw new Error('schema must be a CREATE TABLE (...) statement.');
  const properties = splitTopLevel(body).map((column) => {
    const match = column.match(/^\s*"((?:[^"]|"")+)"\s+(.+)$/s);
    if (!match) throw new Error(`Column names must use double quotes: ${column}`);
    return parseNotionMcpSqlProperty(match[2], match[1].replace(/""/g, '"'));
  });
  validateNotionMcpProperties(properties, { allowDualRelations: true });
  return properties;
}

export function parseNotionMcpDdl(statements: unknown): NotionMcpDdlOperation[] {
  if (typeof statements !== 'string') throw new Error('statements must be a string.');
  return splitTopLevel(statements, ';').map((statement) => {
    let match = statement.match(/^ADD\s+COLUMN\s+"((?:[^"]|"")+)"\s+(.+)$/is);
    if (match) return {
      action: 'add',
      property: parseNotionMcpSqlProperty(match[2], match[1].replace(/""/g, '"')),
      raw: statement,
    };
    match = statement.match(/^DROP\s+COLUMN\s+"((?:[^"]|"")+)"$/is);
    if (match) return { action: 'drop', name: match[1].replace(/""/g, '"'), raw: statement };
    match = statement.match(/^RENAME\s+COLUMN\s+"((?:[^"]|"")+)"\s+TO\s+"((?:[^"]|"")+)"$/is);
    if (match) return {
      action: 'rename', from: match[1].replace(/""/g, '"'), to: match[2].replace(/""/g, '"'), raw: statement,
    };
    match = statement.match(/^ALTER\s+COLUMN\s+"((?:[^"]|"")+)"\s+SET\s+(.+)$/is);
    if (match) return {
      action: 'alter', name: match[1].replace(/""/g, '"'),
      property: parseNotionMcpSqlProperty(match[2], match[1].replace(/""/g, '"')), raw: statement,
    };
    throw new Error(`Unsupported data source DDL statement: ${statement}`);
  });
}

export function notionMcpTypedDatabaseProperties(type: NotionMcpDatabaseType): NotionMcpSqlProperty[] {
  if (type === 'tasks') {
    return [
      { name: 'Task name', type: 'title' },
      { name: 'Status', type: 'status', options: [
        { name: 'Not started', color: 'default' }, { name: 'In progress', color: 'blue' }, { name: 'Done', color: 'green' },
      ] },
      { name: 'Assignee', type: 'people' },
      { name: 'Due', type: 'date' },
      { name: 'Priority', type: 'select', options: [
        { name: 'High', color: 'red' }, { name: 'Medium', color: 'yellow' }, { name: 'Low', color: 'blue' },
      ] },
    ];
  }
  if (type === 'projects') {
    return [
      { name: 'Project name', type: 'title' },
      { name: 'Status', type: 'status', options: [
        { name: 'Planning', color: 'default' }, { name: 'In progress', color: 'blue' }, { name: 'Complete', color: 'green' },
      ] },
      { name: 'Owner', type: 'people' },
      { name: 'Start date', type: 'date' },
      { name: 'Target date', type: 'date' },
    ];
  }
  return [
    { name: 'Skill name', type: 'title' },
    { name: 'Description', type: 'rich_text' },
    { name: 'Category', type: 'select', options: [] },
    { name: 'Level', type: 'select', options: [
      { name: 'Beginner', color: 'green' }, { name: 'Intermediate', color: 'yellow' }, { name: 'Advanced', color: 'red' },
    ] },
  ];
}

export function validateNotionMcpProperties(
  properties: NotionMcpSqlProperty[],
  options: { allowDualRelations?: boolean } = {},
) {
  if (properties.length > 100) throw new Error('A database can have at most 100 properties.');
  const names = new Set<string>();
  let titles = 0;
  let uniqueIds = 0;
  for (const property of properties) {
    const name = property.name.trim();
    if (!name) throw new Error('Database property names cannot be empty.');
    const key = name.toLocaleLowerCase();
    if (names.has(key)) throw new Error(`Duplicate database property name: ${name}.`);
    names.add(key);
    if (property.type === 'title') titles += 1;
    if (property.type === 'unique_id') uniqueIds += 1;
    if (property.relationDual && !options.allowDualRelations) {
      throw new Error('Create the database first, then add a DUAL relation with notion-update-data-source.');
    }
  }
  if (titles > 1) throw new Error('A database can have only one title property.');
  if (uniqueIds > 1) throw new Error('A database can have only one unique_id property.');
}

export function notionMcpPropertySchema(property: NotionMcpSqlProperty): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  if (property.type === 'select' || property.type === 'multi_select' || property.type === 'status') {
    config = { options: property.options ?? [] };
  } else if (property.type === 'number') {
    config = { format: property.numberFormat ?? 'number' };
  } else if (property.type === 'formula') {
    config = { expression: property.formula ?? '' };
  } else if (property.type === 'relation') {
    config = {
      data_source_id: property.relationDataSourceId,
      ...(property.relationDual
        ? {
            type: 'dual_property',
            dual_property: {
              ...(property.relationDual.syncedPropertyName ? { synced_property_name: property.relationDual.syncedPropertyName } : {}),
              ...(property.relationDual.syncedPropertyId ? { synced_property_id: property.relationDual.syncedPropertyId } : {}),
            },
          }
        : { type: 'single_property', single_property: {} }),
    };
  } else if (property.type === 'rollup') {
    config = {
      relation_property_id: property.rollupRelationPropertyId,
      rollup_property_id: property.rollupTargetPropertyId,
      function: property.rollupFunction ?? 'show_original',
    };
  } else if (property.type === 'unique_id') {
    config = { prefix: property.uniqueIdPrefix || null };
  }
  return {
    type: property.type,
    ...(property.description !== undefined ? { description: property.description } : {}),
    [property.type]: config,
  };
}

export function notionMcpPropertySchemaMap(properties: NotionMcpSqlProperty[]) {
  const withTitle = properties.some((property) => property.type === 'title')
    ? properties
    : [{ name: 'Name', type: 'title' }, ...properties];
  validateNotionMcpProperties(withTitle, { allowDualRelations: false });
  return Object.fromEntries(withTitle.map((property) => [property.name, notionMcpPropertySchema(property)]));
}

interface MutableSchemaEntry {
  originKey?: string;
  name: string;
  schema: Record<string, unknown>;
  deleted?: boolean;
  added?: boolean;
  renamed?: boolean;
  altered?: boolean;
}

function schemaType(schema: Record<string, unknown>) {
  if (typeof schema.type === 'string') return schema.type;
  return Object.keys(schema).find((key) => !['id', 'name', 'description'].includes(key)) ?? 'rich_text';
}

function findSchemaEntry(entries: MutableSchemaEntry[], name: string) {
  const key = name.toLocaleLowerCase();
  return entries.find((entry) => !entry.deleted && entry.name.toLocaleLowerCase() === key);
}

export function notionMcpDdlPatch(
  currentProperties: Record<string, unknown>,
  operations: NotionMcpDdlOperation[],
) {
  if (!operations.length) return {};
  const entries: MutableSchemaEntry[] = Object.entries(currentProperties).map(([key, raw]) => {
    const schema = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    return { originKey: typeof schema.id === 'string' && schema.id ? schema.id : key, name: typeof schema.name === 'string' && schema.name ? schema.name : key, schema };
  });
  for (const operation of operations) {
    if (operation.action === 'add') {
      if (operation.property.type === 'title') throw new Error('Cannot add a second title property.');
      if (findSchemaEntry(entries, operation.property.name)) throw new Error(`Property "${operation.property.name}" already exists.`);
      entries.push({
        name: operation.property.name,
        schema: notionMcpPropertySchema(operation.property),
        added: true,
      });
      continue;
    }
    if (operation.action === 'drop') {
      const entry = findSchemaEntry(entries, operation.name);
      if (!entry) throw new Error(`Property "${operation.name}" was not found.`);
      if (schemaType(entry.schema) === 'title') throw new Error('Cannot delete the title property.');
      entry.deleted = true;
      continue;
    }
    if (operation.action === 'rename') {
      const entry = findSchemaEntry(entries, operation.from);
      if (!entry) throw new Error(`Property "${operation.from}" was not found.`);
      const duplicate = findSchemaEntry(entries, operation.to);
      if (duplicate && duplicate !== entry) throw new Error(`Property "${operation.to}" already exists.`);
      entry.name = operation.to;
      entry.renamed = true;
      continue;
    }
    const entry = findSchemaEntry(entries, operation.name);
    if (!entry) throw new Error(`Property "${operation.name}" was not found.`);
    if (schemaType(entry.schema) === 'title' || operation.property.type === 'title') {
      throw new Error('Cannot alter the title property type.');
    }
    entry.schema = notionMcpPropertySchema({ ...operation.property, name: entry.name });
    entry.altered = true;
  }
  const live = entries.filter((entry) => !entry.deleted);
  if (live.filter((entry) => schemaType(entry.schema) === 'unique_id').length > 1) {
    throw new Error('A database can have only one unique_id property.');
  }
  const patch: Record<string, unknown> = {};
  for (const entry of entries) {
    if (entry.deleted) {
      if (entry.originKey) patch[entry.originKey] = null;
      continue;
    }
    if (entry.added) {
      patch[entry.name] = entry.schema;
      continue;
    }
    if (!entry.renamed && !entry.altered) continue;
    if (!entry.originKey) throw new Error(`Property "${entry.name}" has no stable identifier.`);
    patch[entry.originKey] = entry.altered
      ? { ...entry.schema, ...(entry.renamed ? { name: entry.name } : {}) }
      : { name: entry.name };
  }
  return patch;
}
