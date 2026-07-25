import type { NotionDatabaseViewType } from './database-view-types';
import {
  NOTION_CHART_AGGREGATES,
  normalizeNotionChartAggregate,
  notionChartAggregateSupportsProperty,
} from '../../shared/notion-chart-aggregates.mjs';
import {
  HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES,
  notionBoardMainGroupPropertyType,
} from '../../shared/board-group-types.mjs';

export interface NotionViewDslProperty {
  id: string;
  name: string;
  type: string;
  config?: Record<string, unknown> | null;
}

export interface NotionViewConfigurePlan {
  body: Record<string, unknown>;
  config: Record<string, unknown>;
  changed: boolean;
}

type ParsedViewConfigure = Record<string, unknown>;

const chartAggregates = new Set<string>(NOTION_CHART_AGGREGATES);
const chartColors = new Set([
  'gray', 'blue', 'yellow', 'green', 'purple', 'teal', 'orange', 'pink', 'red', 'auto', 'colorful',
]);
const chartHeights = new Set(['small', 'medium', 'large', 'extra_large']);
const chartSorts = new Set(['manual', 'x_ascending', 'x_descending', 'y_ascending', 'y_descending']);
const formPermissions = new Set(['none', 'comment_only', 'reader', 'read_and_write', 'editor']);
const chartOptionStart = /^(?:COLOR|HEIGHT|SORT|STACK\s+BY|CAPTION)\b/i;
const countByGuidance = 'CHART AGGREGATE count does not accept BY; use count_values BY "Property".';
const officialPresentationKeys = [
  'properties', 'group_by', 'sub_group_by', 'date_property_id', 'end_date_property_id',
  'map_by', 'cover', 'wrap_cells', 'frozen_column_index', 'x_axis', 'chart_type',
  'y_axis', 'value', 'stack_by', 'color_theme', 'height', 'sort', 'caption',
  'is_form_closed', 'anonymous_submissions', 'submission_permissions',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function quotedList(value: unknown) {
  const text = String(value ?? '');
  const quoted = [...text.matchAll(/"([^"]+)"|'([^']+)'/g)]
    .map((match) => match[1] ?? match[2])
    .filter(Boolean) as string[];
  return quoted.length ? quoted : text.split(',').map((item) => item.trim()).filter(Boolean);
}

function leadingValue(value: unknown, label: string) {
  const text = String(value ?? '').trimStart();
  const quoted = text.match(/^(?:"([^"]+)"|'([^']+)')/);
  if (quoted) return { value: quoted[1] ?? quoted[2]!, rest: text.slice(quoted[0].length).trimStart() };
  const bare = text.match(/^(\S+)/);
  if (!bare) throw new Error(`${label} requires a value.`);
  return { value: bare[1]!, rest: text.slice(bare[0].length).trimStart() };
}

function parseChartDirective(directive: string) {
  const match = directive.match(/^CHART\s+(column|bar|line|donut|number)\b(.*)$/i);
  if (!match) return null;
  const parsed: ParsedViewConfigure = { chartType: match[1]!.toLowerCase() };
  let rest = match[2]!.trim();
  while (rest) {
    let option = rest.match(/^AGGREGATE\s+([a-z_]+)\b(.*)$/i);
    if (option) {
      const aggregate = option[1]!.toLowerCase();
      if (!chartAggregates.has(aggregate)) throw new Error(`Unsupported CHART AGGREGATE value: ${option[1]}`);
      parsed.chartAggregate = aggregate;
      const tail = option[2]!.trimStart();
      const by = tail.match(/^BY\b\s*/i);
      if (aggregate === 'count') {
        if (by || (tail && !chartOptionStart.test(tail))) throw new Error(countByGuidance);
        rest = tail;
        continue;
      }
      const propertyText = by ? tail.slice(by[0].length) : tail;
      if (!propertyText) {
        throw new Error(`CHART AGGREGATE ${aggregate} requires a property after BY "Property".`);
      }
      if (!by && chartOptionStart.test(propertyText)) {
        throw new Error(
          `CHART AGGREGATE ${aggregate} requires a property after BY "Property"; `
          + 'use BY when the property name is also a CHART option.',
        );
      }
      const property = leadingValue(propertyText, `CHART AGGREGATE ${aggregate}`);
      parsed.chartAggregateBy = property.value;
      rest = property.rest;
      continue;
    }
    option = rest.match(/^COLOR\s+([a-z_]+)\b(.*)$/i);
    if (option) {
      const color = option[1]!.toLowerCase();
      if (!chartColors.has(color)) throw new Error(`Unsupported CHART COLOR value: ${option[1]}`);
      parsed.chartColor = color;
      rest = option[2]!.trim();
      continue;
    }
    option = rest.match(/^HEIGHT\s+([a-z_]+)\b(.*)$/i);
    if (option) {
      const height = option[1]!.toLowerCase();
      if (!chartHeights.has(height)) throw new Error(`Unsupported CHART HEIGHT value: ${option[1]}`);
      parsed.chartHeight = height;
      rest = option[2]!.trim();
      continue;
    }
    option = rest.match(/^SORT\s+([a-z_]+)\b(.*)$/i);
    if (option) {
      const sort = option[1]!.toLowerCase();
      if (!chartSorts.has(sort)) throw new Error(`Unsupported CHART SORT value: ${option[1]}`);
      parsed.chartSort = sort;
      rest = option[2]!.trim();
      continue;
    }
    option = rest.match(/^STACK\s+BY\s+(.+)$/i);
    if (option) {
      const property = leadingValue(option[1], 'CHART STACK BY');
      parsed.chartStackBy = property.value;
      rest = property.rest;
      continue;
    }
    option = rest.match(/^CAPTION\s+(.+)$/i);
    if (option) {
      const caption = leadingValue(option[1], 'CHART CAPTION');
      parsed.chartCaption = caption.value;
      rest = caption.rest;
      continue;
    }
    throw new Error(`Unsupported CHART option: ${rest}`);
  }
  return parsed;
}

export function parseNotionViewConfigDsl(configure: unknown): ParsedViewConfigure {
  const parsed: ParsedViewConfigure = {};
  const directives = String(configure ?? '').split(/[;\n]+/).map((item) => item.trim()).filter(Boolean);
  for (const directive of directives) {
    let match = directive.match(/^CLEAR\s+FILTERS?$/i);
    if (match) {
      parsed.clearFilter = true;
      parsed.filters = [];
      continue;
    }
    match = directive.match(/^CLEAR\s+SORTS?$/i);
    if (match) {
      parsed.clearSort = true;
      parsed.sorts = [];
      continue;
    }
    match = directive.match(/^CLEAR\s+GROUP\s+BY$/i);
    if (match) {
      parsed.clearGroupBy = true;
      parsed.groupBy = '';
      continue;
    }
    match = directive.match(/^SORT\s+BY\s+(.+?)(?:\s+(ASC|DESC))?$/i);
    if (match) {
      parsed.sorts = quotedList(match[1]).map((property) => ({
        property,
        direction: String(match![2] ?? 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc',
      }));
      continue;
    }
    match = directive.match(/^FILTER\s+"([^"]+)"\s*(=|!=|CONTAINS)\s*(?:"([^"]*)"|'([^']*)'|(.+))$/i);
    if (match) {
      const operator = match[2] === '!=' ? 'does_not_equal' : match[2]!.toUpperCase() === 'CONTAINS' ? 'contains' : 'equals';
      const value = match[3] ?? match[4] ?? String(match[5] ?? '').trim();
      parsed.filters = [...(Array.isArray(parsed.filters) ? parsed.filters : []), {
        property: match[1], operator, value,
      }];
      continue;
    }
    match = directive.match(/^FILTER\s+"([^"]+)"\s+IS\s+(NOT\s+)?EMPTY$/i);
    if (match) {
      parsed.filters = [...(Array.isArray(parsed.filters) ? parsed.filters : []), {
        property: match[1], operator: match[2] ? 'is_not_empty' : 'is_empty',
      }];
      continue;
    }
    match = directive.match(/^GROUP\s+BY\s+(.+)$/i);
    if (match) {
      parsed.groupBy = quotedList(match[1])[0] ?? '';
      continue;
    }
    match = directive.match(/^CALENDAR\s+BY\s+(.+)$/i);
    if (match) {
      parsed.calendarBy = quotedList(match[1])[0] ?? '';
      continue;
    }
    match = directive.match(/^TIMELINE\s+BY\s+(.+)$/i);
    if (match) {
      const parts = String(match[1]).split(/\s+TO\s+/i);
      parsed.timelineBy = quotedList(parts[0])[0] ?? '';
      if (parts[1]) parsed.timelineEndBy = quotedList(parts[1])[0] ?? '';
      continue;
    }
    match = directive.match(/^TIMELINE\s+END\s+BY\s+(.+)$/i);
    if (match) {
      parsed.timelineEndBy = quotedList(match[1])[0] ?? '';
      continue;
    }
    match = directive.match(/^MAP\s+BY\s+(.+)$/i);
    if (match) {
      parsed.mapBy = quotedList(match[1])[0] ?? '';
      continue;
    }
    const chart = parseChartDirective(directive);
    if (chart) {
      Object.assign(parsed, chart);
      continue;
    }
    match = directive.match(/^FORM\s+(CLOSE|OPEN)$/i);
    if (match) {
      parsed.formClosed = match[1]!.toUpperCase() === 'CLOSE';
      continue;
    }
    match = directive.match(/^FORM\s+ANONYMOUS\s+(true|false)$/i);
    if (match) {
      parsed.formAnonymous = match[1]!.toLowerCase() === 'true';
      continue;
    }
    match = directive.match(/^FORM\s+PERMISSIONS\s+([a-z_]+)$/i);
    if (match) {
      const permission = match[1]!.toLowerCase();
      if (!formPermissions.has(permission)) throw new Error(`Unsupported FORM PERMISSIONS value: ${match[1]}`);
      parsed.formPermissions = permission;
      continue;
    }
    match = directive.match(/^SHOW\s+(.+)$/i);
    if (match) {
      parsed.visibleProperties = quotedList(match[1]);
      continue;
    }
    match = directive.match(/^HIDE\s+(.+)$/i);
    if (match) {
      parsed.hiddenProperties = quotedList(match[1]);
      continue;
    }
    match = directive.match(/^COVER\s+(.+)$/i);
    if (match) {
      parsed.coverProperty = quotedList(match[1])[0] ?? '';
      continue;
    }
    if (/^WRAP\s+CELLS?$/i.test(directive) || /^WRAP$/i.test(directive)) {
      parsed.wrap = true;
      continue;
    }
    if (/^(NO\s+WRAP|UNWRAP)(\s+CELLS?)?$/i.test(directive)) {
      parsed.wrap = false;
      continue;
    }
    match = directive.match(/^FREEZE\s+COLUMNS?(?:\s+(\d+))?$/i);
    if (match) {
      parsed.frozenColumnIndex = Number(match[1] ?? 1);
      continue;
    }
    match = directive.match(/^FREEZE\s+COLUMNS?(?:\s+THROUGH)?\s+(.+)$/i);
    if (match) {
      parsed.frozenColumnThrough = quotedList(match[1])[0] ?? '';
      continue;
    }
    throw new Error(`Unsupported Hanji view configure directive: ${directive}`);
  }
  return parsed;
}

export function assertRequiredNotionViewConfigure(type: NotionDatabaseViewType, parsed: ParsedViewConfigure) {
  const required: Partial<Record<NotionDatabaseViewType, [string, string]>> = {
    board: ['groupBy', 'GROUP BY "Property"'],
    calendar: ['calendarBy', 'CALENDAR BY "Property"'],
    timeline: ['timelineBy', 'TIMELINE BY "Start"'],
    map: ['mapBy', 'MAP BY "Property"'],
    chart: ['chartType', 'CHART column|bar|line|donut|number'],
  };
  const rule = required[type];
  if (!rule || parsed[rule[0]]) return;
  throw new Error(`${rule[1]} is required when creating a ${type} view.`);
}

function propertyByKey(properties: NotionViewDslProperty[], key: unknown) {
  const raw = String(key ?? '').trim();
  const needle = raw.toLowerCase();
  return properties.find((property) => property.id === raw || property.name.trim().toLowerCase() === needle);
}

function formatAllowedPropertyTypes(allowed: string[]) {
  if (allowed.length < 2) return allowed[0] ?? '';
  if (allowed.length === 2) return `${allowed[0]} or ${allowed[1]}`;
  return `${allowed.slice(0, -1).join(', ')}, or ${allowed.at(-1)}`;
}

function requiredProperty(properties: NotionViewDslProperty[], key: unknown, label: string, allowed?: string[]) {
  const property = propertyByKey(properties, key);
  if (!property) throw new Error(`${label} property "${String(key ?? '')}" not found.`);
  if (allowed && !allowed.includes(property.type)) {
    throw new Error(`${label} must use ${formatAllowedPropertyTypes(allowed)} properties.`);
  }
  return property;
}

function groupConfiguration(property: NotionViewDslProperty) {
  const type = notionBoardMainGroupPropertyType(property.type) ?? property.type;
  return {
    type,
    property_id: property.id,
    sort: { type: 'manual' },
    ...(type === 'status' ? { group_by: 'group' } : {}),
  };
}

function officialFilterKey(type: string) {
  if (type === 'title') return 'title';
  if (type === 'number' || type === 'unique_id') return 'number';
  if (type === 'checkbox') return 'checkbox';
  if (type === 'select' || type === 'status' || type === 'multi_select' || type === 'date') return type;
  if (type === 'person' || type === 'created_by' || type === 'last_edited_by') return 'people';
  if (type === 'relation' || type === 'files') return type;
  return 'rich_text';
}

function localFilterValue(property: NotionViewDslProperty, value: unknown) {
  if (property.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Filter value for "${property.name}" must be a number.`);
    return number;
  }
  if (property.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    return !['false', '0', 'no', 'unchecked'].includes(String(value ?? '').trim().toLowerCase());
  }
  if (['select', 'status', 'multi_select'].includes(property.type)) {
    const options = Array.isArray(property.config?.options) ? property.config!.options : [];
    const option = options.find((candidate) => isRecord(candidate)
      && (candidate.id === value || String(candidate.name ?? '').toLowerCase() === String(value ?? '').toLowerCase()));
    if (isRecord(option) && typeof option.id === 'string') return option.id;
  }
  return value;
}

function officialFilterValue(property: NotionViewDslProperty, value: unknown) {
  if (property.type === 'number' || property.type === 'unique_id') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Filter value for "${property.name}" must be a number.`);
    return number;
  }
  if (property.type === 'checkbox') {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'checked'].includes(normalized)) return true;
    if (['false', '0', 'no', 'unchecked'].includes(normalized)) return false;
    throw new Error(`Filter value for "${property.name}" must be a boolean.`);
  }
  return value;
}

function priorOfficialConfiguration(config: Record<string, unknown>) {
  const metadata = isRecord(config.__notionCompat) ? config.__notionCompat : {};
  return isRecord(metadata.configuration) ? metadata.configuration : config;
}

export function notionViewConfigurePlan(
  type: NotionDatabaseViewType,
  configure: unknown,
  properties: NotionViewDslProperty[],
  currentConfig: Record<string, unknown> = {},
): NotionViewConfigurePlan {
  const parsed = isRecord(configure) ? configure : parseNotionViewConfigDsl(configure);
  const config: Record<string, unknown> = { ...currentConfig, type };
  const body: Record<string, unknown> = {};
  let changed = false;

  if (Array.isArray(parsed.filters)) {
    const localFilters: Record<string, unknown>[] = [];
    const officialFilters: Record<string, unknown>[] = [];
    for (const candidate of parsed.filters) {
      if (!isRecord(candidate)) continue;
      const property = requiredProperty(properties, candidate.property, 'Filter');
      const operator = String(candidate.operator ?? 'equals');
      const noValue = operator === 'is_empty' || operator === 'is_not_empty';
      officialFilters.push({
        property: property.id,
        [officialFilterKey(property.type)]: {
          [operator]: noValue ? true : officialFilterValue(property, candidate.value),
        },
      });
      localFilters.push({
        propertyId: property.id,
        property: property.name,
        operator,
        ...(!noValue ? { value: localFilterValue(property, candidate.value) } : {}),
      });
    }
    const official = officialFilters.length === 0
      ? null
      : officialFilters.length === 1
        ? officialFilters[0]
        : { and: officialFilters };
    body.filter = official;
    config.filter = official;
    if (localFilters.length) config.filterGroup = { conjunction: 'and', filters: localFilters, groups: [] };
    else delete config.filterGroup;
    delete config.filters;
    delete config.filterConjunction;
    changed = true;
  }

  if (Array.isArray(parsed.sorts)) {
    const localSorts = parsed.sorts.filter(isRecord).map((candidate) => {
      const property = requiredProperty(properties, candidate.property, 'Sort');
      const direction = candidate.direction === 'desc' ? 'desc' : 'asc';
      return { propertyId: property.id, property: property.name, direction };
    });
    body.sorts = localSorts.length
      ? localSorts.map((sort) => ({ property: sort.property, direction: sort.direction === 'desc' ? 'descending' : 'ascending' }))
      : null;
    config.sorts = localSorts;
    changed = true;
  }

  const presentationKeys = [
    'visibleProperties', 'hiddenProperties', 'groupBy', 'clearGroupBy', 'calendarBy', 'timelineBy',
    'timelineEndBy', 'mapBy', 'coverProperty', 'wrap', 'frozenColumnIndex', 'frozenColumnThrough',
    'chartType', 'chartAggregate', 'chartAggregateBy', 'chartStackBy', 'chartColor', 'chartHeight',
    'chartSort', 'chartCaption', 'formClosed', 'formAnonymous', 'formPermissions',
  ];
  const presentationChanged = presentationKeys.some((key) => parsed[key] !== undefined);
  if (presentationChanged) {
    if (type === 'dashboard') throw new Error('Dashboard views do not accept a presentation configuration.');
    const prior = priorOfficialConfiguration(currentConfig);
    const configuration: Record<string, unknown> = { type };
    for (const key of officialPresentationKeys) {
      if (prior[key] !== undefined) configuration[key] = prior[key];
    }
    if (Array.isArray(parsed.visibleProperties) || Array.isArray(parsed.hiddenProperties)) {
      const visible = Array.isArray(parsed.visibleProperties)
        ? new Set(parsed.visibleProperties.map((key) => requiredProperty(properties, key, 'SHOW').id))
        : new Set(properties.map((property) => property.id));
      if (Array.isArray(parsed.hiddenProperties)) {
        for (const key of parsed.hiddenProperties) visible.delete(requiredProperty(properties, key, 'HIDE').id);
      }
      config.visibleProperties = properties.filter((property) => visible.has(property.id)).map((property) => property.id);
      configuration.properties = properties.map((property) => ({ property_id: property.id, visible: visible.has(property.id) }));
    }
    if (parsed.groupBy !== undefined) {
      if (String(parsed.groupBy).trim()) {
        const property = requiredProperty(
          properties,
          parsed.groupBy,
          'GROUP BY',
          type === 'board' ? [...HANJI_BOARD_MAIN_GROUP_PROPERTY_TYPES] : undefined,
        );
        if (type === 'chart') {
          config.chartGroupBy = property.id;
          configuration.x_axis = groupConfiguration(property);
        } else {
          config.groupBy = property.id;
          configuration.group_by = groupConfiguration(property);
        }
      } else if (type === 'chart') {
        delete config.chartGroupBy;
        configuration.x_axis = null;
      } else {
        delete config.groupBy;
        configuration.group_by = null;
      }
    }
    for (const [inputKey, localKey, officialKey, allowed] of [
      ['calendarBy', 'calendarBy', 'date_property_id', ['date']],
      ['timelineBy', 'timelineBy', 'date_property_id', ['date']],
      ['timelineEndBy', 'timelineEndBy', 'end_date_property_id', ['date']],
      ['mapBy', 'mapBy', 'map_by', ['place', 'location']],
    ] as const) {
      if (parsed[inputKey] === undefined) continue;
      const property = requiredProperty(properties, parsed[inputKey], inputKey, [...allowed]);
      config[localKey] = property.id;
      configuration[officialKey] = property.id;
    }
    if (parsed.coverProperty !== undefined) {
      const raw = String(parsed.coverProperty).trim().toLowerCase();
      if (!raw || raw === 'page' || raw === '__page_cover') {
        delete config.coverProperty;
        configuration.cover = { type: 'page_cover' };
      } else if (raw === 'none' || raw === '__none') {
        config.coverProperty = '__none';
        configuration.cover = null;
      } else {
        const property = requiredProperty(properties, parsed.coverProperty, 'COVER', ['files', 'url']);
        config.coverProperty = property.id;
        configuration.cover = { type: 'property', property_id: property.id };
      }
    }
    if (parsed.wrap !== undefined) {
      config.wrap = parsed.wrap;
      configuration.wrap_cells = parsed.wrap;
    }
    if (parsed.frozenColumnIndex !== undefined || parsed.frozenColumnThrough !== undefined) {
      let frozen = Number(parsed.frozenColumnIndex);
      if (parsed.frozenColumnThrough !== undefined) {
        const property = requiredProperty(properties, parsed.frozenColumnThrough, 'FREEZE COLUMNS');
        const order = Array.isArray(config.propertyOrder) ? config.propertyOrder : properties.map((candidate) => candidate.id);
        const index = order.indexOf(property.id);
        if (index < 0) throw new Error(`FREEZE COLUMNS property "${property.name}" is not in this view.`);
        frozen = index + 1;
      }
      if (!Number.isInteger(frozen) || frozen < 0) throw new Error('FREEZE COLUMNS requires a non-negative integer.');
      config.frozenColumnIndex = frozen;
      configuration.frozen_column_index = frozen;
    }
    const chartInput = presentationKeys.slice(12, 20).some((key) => parsed[key] !== undefined);
    if (chartInput && type !== 'chart') throw new Error('CHART configuration can only be set on chart views.');
    if (parsed.chartType !== undefined) {
      const chartType = String(parsed.chartType);
      configuration.chart_type = chartType;
      config.chartType = ({ column: 'bar', bar: 'horizontal_bar', line: 'line', donut: 'donut' } as Record<string, string>)[chartType];
      if (!config.chartType) delete config.chartType;
    }
    if (parsed.chartAggregate !== undefined || parsed.chartAggregateBy !== undefined) {
      const targetKey = (parsed.chartType ?? prior.chart_type) === 'number' ? 'value' : 'y_axis';
      const fallbackKey = targetKey === 'value' ? 'y_axis' : 'value';
      const previousAggregation = [
        prior[targetKey], currentConfig[targetKey], prior[fallbackKey], currentConfig[fallbackKey],
      ].find(isRecord);
      const aggregate = normalizeNotionChartAggregate(String(
        parsed.chartAggregate
        ?? previousAggregation?.aggregator
        ?? currentConfig.chartAggregate
        ?? 'count',
      ));
      if (!aggregate) throw new Error('Unsupported CHART AGGREGATE value.');
      let property: NotionViewDslProperty | undefined;
      if (parsed.chartAggregateBy !== undefined) {
        if (aggregate === 'count') throw new Error(countByGuidance);
        property = requiredProperty(properties, parsed.chartAggregateBy, 'CHART AGGREGATE');
      } else if (!(parsed.chartAggregate !== undefined && aggregate === 'count')) {
        const previousProperty = previousAggregation?.property_id ?? currentConfig.chartAggregateBy;
        if (previousProperty !== undefined) {
          property = requiredProperty(properties, previousProperty, 'CHART AGGREGATE');
        }
      }
      if (aggregate !== 'count' && !property) throw new Error(`CHART AGGREGATE ${aggregate} requires a property.`);
      if (property && !notionChartAggregateSupportsProperty(aggregate, property.type)) {
        throw new Error(
          `CHART AGGREGATE ${aggregate} does not support ${property.type} property "${property.name}".`,
        );
      }
      const aggregation = { aggregator: aggregate, ...(property ? { property_id: property.id } : {}) };
      configuration[targetKey] = aggregation;
      config.chartAggregate = aggregate;
      if (aggregate !== 'count' && property) config.chartAggregateBy = property.id;
      else delete config.chartAggregateBy;
    }
    if (parsed.chartStackBy !== undefined) {
      configuration.stack_by = groupConfiguration(requiredProperty(properties, parsed.chartStackBy, 'CHART STACK BY'));
    }
    for (const [inputKey, officialKey] of [
      ['chartColor', 'color_theme'], ['chartHeight', 'height'], ['chartSort', 'sort'], ['chartCaption', 'caption'],
    ]) {
      if (parsed[inputKey] !== undefined) configuration[officialKey] = parsed[inputKey];
    }
    const formInput = ['formClosed', 'formAnonymous', 'formPermissions'].some((key) => parsed[key] !== undefined);
    if (formInput && type !== 'form') throw new Error('FORM configuration can only be set on form views.');
    for (const [inputKey, officialKey] of [
      ['formClosed', 'is_form_closed'],
      ['formAnonymous', 'anonymous_submissions'],
      ['formPermissions', 'submission_permissions'],
    ]) {
      if (parsed[inputKey] !== undefined) configuration[officialKey] = parsed[inputKey];
    }
    Object.assign(config, configuration);
    body.configuration = configuration;
    changed = true;
  }

  return { body, config, changed };
}
