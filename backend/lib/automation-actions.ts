import type { Block, DbProperty } from './app-types';
import {
  isReadOnlyDatabasePropertyType,
  normalizeDatabasePropertyWriteValue,
} from './database-property-types';
import { hasPotentialStoredFileReference } from './file-reference-lifecycle';
import {
  type DatabaseAutomationDailyScheduleTrigger,
  validScheduleDate,
  validScheduleTimeZone,
} from './database-automation-schedule';
import { normalizePublicUrl } from './ssrf-guard';
import {
  evaluateFormulaExpression,
  type FormulaValue,
} from '../../shared/database/formula-core';
import { formulaPropertyValue } from './formula-property-value';

export const MAX_AUTOMATION_ACTIONS = 20;
export const MAX_AUTOMATION_DOCUMENT_BYTES = 64 * 1024;
export const MAX_AUTOMATION_RESULT_BYTES = 256 * 1024;
export const MAX_AUTOMATION_INSERT_BLOCKS = 100;
export const MAX_AUTOMATION_BLOCK_DEPTH = 20;
export const MAX_AUTOMATION_TRIGGER_CONDITIONS = 20;
export const MAX_AUTOMATION_NOTIFICATION_RECIPIENTS = 20;
export const MAX_AUTOMATION_TARGET_ROWS = 100;
export const MAX_AUTOMATION_VARIABLES = 20;
export const MAX_AUTOMATION_FORMULA_CHARACTERS = 4_096;
export const MAX_AUTOMATION_FILTER_BYTES = 32 * 1024;

export type AutomationValueExpression =
  | { kind: 'literal'; value: unknown }
  | { kind: 'execution_time' }
  | { kind: 'formula'; expression: string }
  | { kind: 'variable'; name: string }
  | { kind: 'trigger_property'; propertyId: string };

export type AutomationDynamicText = string | AutomationValueExpression;

export interface EditPropertyAutomationAction {
  id: string;
  type: 'edit_property';
  target: 'trigger_page';
  propertyId: string;
  value: AutomationValueExpression;
}

export interface AutomationBlockTemplate {
  type: string;
  content?: Record<string, unknown>;
  children?: AutomationBlockTemplate[];
}

export interface InsertBlocksAutomationAction {
  id: string;
  type: 'insert_blocks';
  target: 'trigger_page';
  blocks: AutomationBlockTemplate[];
}

export interface AddPageAutomationAction {
  id: string;
  type: 'add_page';
  target: 'database';
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
  type: 'edit_pages';
  target: {
    type: 'database';
    databaseId: string;
    filter: Record<string, unknown>;
    limit: number;
  };
  changes: AutomationPropertyChange[];
}

export interface DefineVariablesAutomationAction {
  id: string;
  type: 'define_variables';
  variables: Array<{
    name: string;
    value: AutomationValueExpression;
  }>;
}

export interface ShowConfirmationAutomationAction {
  id: string;
  type: 'show_confirmation';
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
}

export interface OpenPageAutomationAction {
  id: string;
  type: 'open_page';
  pageId: string;
}

export interface OpenFormAutomationAction {
  id: string;
  type: 'open_form';
  databaseId: string;
  viewId: string;
}

export interface OpenUrlAutomationAction {
  id: string;
  type: 'open_url';
  url: string;
}

export interface SendNotificationAutomationAction {
  id: string;
  type: 'send_notification';
  recipientIds: string[];
  message: string;
}

export interface SendEmailAutomationAction {
  id: string;
  type: 'send_email';
  recipientEmail: string;
  subject: string;
  message: string;
}

export interface SendWebhookAutomationAction {
  id: string;
  type: 'send_webhook';
  url: string;
  body: Record<string, unknown>;
}

export interface SendSlackAutomationAction {
  id: string;
  type: 'send_slack';
  connectionId: string;
  channelId: string;
  message: string;
}

export type DatabaseAutomationScheduleAction =
  | DefineVariablesAutomationAction
  | AddPageAutomationAction
  | EditPagesAutomationAction
  | SendNotificationAutomationAction
  | SendEmailAutomationAction
  | SendWebhookAutomationAction
  | SendSlackAutomationAction;

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

export interface AutomationActionDocument {
  version: 1;
  label: string;
  actions: AutomationAction[];
}

export interface AutomationValueContext {
  databaseProperties: readonly DbProperty[];
  executionTime: string;
  triggerPage: {
    title?: string;
    properties?: Record<string, unknown>;
  };
  variables: Map<string, unknown>;
}

export interface DatabaseButtonActionDocument extends AutomationActionDocument {
  actions: AutomationAction[];
}

export interface DatabaseAutomationEventCondition {
  type: 'row_added' | 'property_edited';
  propertyId?: string;
}

export interface DatabaseAutomationEventDefinitionDocument {
  name: string;
  enabled: boolean;
  scope: { type: 'database' } | { type: 'view'; viewId: string };
  trigger: {
    type: 'events';
    mode: 'any' | 'all';
    conditions: DatabaseAutomationEventCondition[];
  };
  actionDocument: AutomationActionDocument;
}

export interface DatabaseAutomationScheduleActionDocument extends AutomationActionDocument {
  actions: DatabaseAutomationScheduleAction[];
}

export interface DatabaseAutomationScheduleDefinitionDocument {
  name: string;
  enabled: boolean;
  scope: { type: 'database' } | { type: 'view'; viewId: string };
  trigger: DatabaseAutomationDailyScheduleTrigger;
  actionDocument: DatabaseAutomationScheduleActionDocument;
}

export type DatabaseAutomationDefinitionDocument =
  | DatabaseAutomationEventDefinitionDocument
  | DatabaseAutomationScheduleDefinitionDocument;

const EDITABLE_SCALAR_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'person',
  'checkbox',
  'url',
  'email',
  'phone',
  'place',
  'verification',
]);

const PAGE_BUTTON_BLOCK_TYPES = new Set([
  'paragraph',
  'to_do',
  'bulleted_list_item',
  'numbered_list_item',
  'heading_2',
  'callout',
]);

function validationError(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw validationError(`${label} must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

function serializedBytes(value: unknown, label: string) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw validationError(`${label} must serialize as JSON.`);
  }
  if (serialized === undefined) throw validationError(`${label} must serialize as JSON.`);
  return new TextEncoder().encode(serialized).byteLength;
}

function optionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw validationError(`${label} must be a boolean.`);
  return value;
}

function requiredBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') throw validationError(`${label} must be a boolean.`);
  return value;
}

function normalizeBlockTemplate(
  value: unknown,
  label: string,
  depth: number,
  count: { value: number },
): AutomationBlockTemplate {
  if (depth > MAX_AUTOMATION_BLOCK_DEPTH) {
    throw validationError(`Button inserted blocks may be nested at most ${MAX_AUTOMATION_BLOCK_DEPTH} levels.`);
  }
  count.value += 1;
  if (count.value > MAX_AUTOMATION_INSERT_BLOCKS) {
    throw validationError(`Button actions may insert at most ${MAX_AUTOMATION_INSERT_BLOCKS} blocks.`);
  }
  const raw = recordValue(value, label);
  const type = requiredString(raw.type, `${label} type`, 100);
  if (!PAGE_BUTTON_BLOCK_TYPES.has(type)) {
    throw validationError(`Button actions cannot insert block type: ${type}.`);
  }
  const content = raw.content === undefined
    ? undefined
    : recordValue(raw.content, `${label} content`);
  if (content && hasPotentialStoredFileReference(content)) {
    throw validationError('Button inserted blocks cannot contain stored file references.');
  }
  if (raw.children !== undefined && !Array.isArray(raw.children)) {
    throw validationError(`${label} children must be an array.`);
  }
  const children = (raw.children as unknown[] | undefined)?.map((child, index) => (
    normalizeBlockTemplate(child, `${label} child ${index + 1}`, depth + 1, count)
  ));
  return {
    type,
    ...(content ? { content: structuredClone(content) } : {}),
    ...(children?.length ? { children } : {}),
  };
}

function optionIds(property: DbProperty) {
  const options = Array.isArray(property.config?.options) ? property.config.options : [];
  return new Set(options.flatMap((option) => (
    option && typeof option === 'object' && typeof (option as { id?: unknown }).id === 'string'
      ? [(option as { id: string }).id]
      : []
  )));
}

function normalizeOptionLiteral(property: DbProperty, value: unknown) {
  const validIds = optionIds(property);
  if (property.type === 'multi_select') {
    if (value === null) return null;
    if (!Array.isArray(value)) {
      throw validationError(`Button action value contains invalid options for ${property.name || property.id}.`);
    }
    const options = Array.isArray(property.config?.options) ? property.config.options : [];
    const normalized = value.map((item) => {
      if (typeof item !== 'string') return '';
      if (validIds.has(item)) return item;
      const option = options.find((candidate) => (
        candidate && typeof candidate === 'object' && (candidate as { name?: unknown }).name === item
      )) as { id?: unknown } | undefined;
      return typeof option?.id === 'string' ? option.id : '';
    });
    if (normalized.some((item) => !item)) {
      throw validationError(`Button action value contains invalid options for ${property.name || property.id}.`);
    }
    return Array.from(new Set(normalized));
  }
  if (value !== null && (typeof value !== 'string' || !validIds.has(value))) {
    throw validationError(`Button action value contains an invalid option for ${property.name || property.id}.`);
  }
  return value;
}

function normalizeLiteral(property: DbProperty, value: unknown) {
  if (property.type === 'title') {
    if (typeof value !== 'string') {
      throw validationError('A button title action value must be a string.');
    }
    return value;
  }
  if (property.type === 'select' || property.type === 'status' || property.type === 'multi_select') {
    return normalizeOptionLiteral(property, value);
  }
  return normalizeDatabasePropertyWriteValue(property.type, value);
}

function triggerPropertyValue(
  context: AutomationValueContext,
  propertyIdOrName: string,
): unknown {
  const property = context.databaseProperties.find((candidate) => (
    candidate.id === propertyIdOrName || candidate.name === propertyIdOrName
  ));
  if (!property) return '';
  return property.type === 'title'
    ? context.triggerPage.title ?? ''
    : context.triggerPage.properties?.[property.id] ?? null;
}

function triggerFormulaPropertyValue(
  context: AutomationValueContext,
  propertyIdOrName: string,
): FormulaValue {
  const property = context.databaseProperties.find((candidate) => (
    candidate.id === propertyIdOrName || candidate.name === propertyIdOrName
  ));
  if (!property) return '';
  return formulaPropertyValue(context.triggerPage, property);
}

export function evaluateAutomationValueExpression(
  expression: AutomationValueExpression,
  context: AutomationValueContext,
): unknown {
  if (expression.kind === 'literal') return structuredClone(expression.value);
  if (expression.kind === 'execution_time') return context.executionTime;
  if (expression.kind === 'trigger_property') {
    return structuredClone(triggerPropertyValue(context, expression.propertyId));
  }
  if (expression.kind === 'variable') {
    if (!context.variables.has(expression.name)) {
      throw validationError(`Automation variable is not defined: ${expression.name}.`);
    }
    return structuredClone(context.variables.get(expression.name));
  }
  return evaluateFormulaExpression(
    expression.expression,
    (name): FormulaValue => triggerFormulaPropertyValue(context, name),
    { now: () => new Date(context.executionTime) },
  );
}

export function applyAutomationVariableDefinitions(
  action: DefineVariablesAutomationAction,
  context: AutomationValueContext,
) {
  for (const variable of action.variables) {
    context.variables.set(
      variable.name,
      evaluateAutomationValueExpression(variable.value, context),
    );
  }
}

export function evaluateAutomationDynamicText(
  value: AutomationDynamicText,
  context: AutomationValueContext,
) {
  const evaluated = typeof value === 'string'
    ? value
    : evaluateAutomationValueExpression(value, context);
  if (evaluated === null || evaluated === undefined) return '';
  if (typeof evaluated === 'string' || typeof evaluated === 'number' || typeof evaluated === 'boolean') {
    return String(evaluated);
  }
  throw validationError('Automation dynamic text must evaluate to text, a number, or a boolean.');
}

export function evaluateAutomationPropertyValue(
  property: DbProperty,
  expression: AutomationValueExpression,
  context: AutomationValueContext,
) {
  return normalizeLiteral(
    property,
    evaluateAutomationValueExpression(expression, context),
  );
}

function normalizeValueExpression(
  value: unknown,
  label: string,
  knownVariables: ReadonlySet<string>,
  databaseProperties?: readonly DbProperty[],
): AutomationValueExpression {
  const input = recordValue(value, label);
  if (input.kind === 'literal' && Object.prototype.hasOwnProperty.call(input, 'value')) {
    return { kind: 'literal', value: structuredClone(input.value) };
  }
  if (input.kind === 'execution_time') return { kind: 'execution_time' };
  if (input.kind === 'formula') {
    return {
      kind: 'formula',
      expression: requiredString(
        input.expression,
        `${label} formula`,
        MAX_AUTOMATION_FORMULA_CHARACTERS,
      ),
    };
  }
  if (input.kind === 'variable') {
    const name = requiredString(input.name, `${label} variable`, 100);
    if (!knownVariables.has(name)) {
      throw validationError(`${label} references an undefined variable: ${name}.`);
    }
    return { kind: 'variable', name };
  }
  if (input.kind === 'trigger_property') {
    const propertyId = requiredString(input.propertyId, `${label} propertyId`, 160);
    if (databaseProperties && !databaseProperties.some((property) => property.id === propertyId)) {
      throw validationError(`${label} trigger property was not found: ${propertyId}.`);
    }
    return { kind: 'trigger_property', propertyId };
  }
  throw validationError(`${label} must be a literal, execution time, formula, variable, or trigger property.`);
}

function parseValueExpression(
  value: unknown,
  property: DbProperty,
  knownVariables: ReadonlySet<string>,
  databaseProperties: readonly DbProperty[],
): AutomationValueExpression {
  const input = recordValue(value, 'Button action value');
  if (input.kind === 'execution_time') {
    if (property.type !== 'date') {
      throw validationError('Button execution time can only target a date property.');
    }
    return { kind: 'execution_time' };
  }
  if (input.kind !== 'literal') {
    return normalizeValueExpression(
      input,
      'Button action value',
      knownVariables,
      databaseProperties,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'value')) {
    throw validationError('Button action literal value is required.');
  }
  return { kind: 'literal', value: normalizeLiteral(property, input.value) };
}

type AutomationActionSurface =
  | 'database_button'
  | 'page_button'
  | 'event_automation'
  | 'schedule_automation';

function isButtonSurface(surface: AutomationActionSurface) {
  return surface === 'database_button' || surface === 'page_button';
}

function normalizeDynamicText(
  value: unknown,
  label: string,
  knownVariables: ReadonlySet<string>,
  databaseProperties?: readonly DbProperty[],
): AutomationDynamicText {
  if (typeof value === 'string') return requiredString(value, label, 2_000);
  return normalizeValueExpression(value, label, knownVariables, databaseProperties);
}

function normalizePropertyChanges(
  value: unknown,
  label: string,
  knownVariables: ReadonlySet<string>,
  databaseProperties?: readonly DbProperty[],
) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_AUTOMATION_TARGET_ROWS) {
    throw validationError(
      `${label} must include 1-${MAX_AUTOMATION_TARGET_ROWS} property changes.`,
    );
  }
  const propertyIds = new Set<string>();
  return value.map((rawChange, index): AutomationPropertyChange => {
    const change = recordValue(rawChange, `${label} ${index + 1}`);
    const propertyId = requiredString(change.propertyId, `${label} ${index + 1} propertyId`, 160);
    if (propertyIds.has(propertyId)) throw validationError(`${label} repeats property: ${propertyId}.`);
    propertyIds.add(propertyId);
    return {
      propertyId,
      value: normalizeValueExpression(
        change.value,
        `${label} ${index + 1} value`,
        knownVariables,
        databaseProperties,
      ),
    };
  });
}

function normalizeAutomationActionDocument(
  rawDocument: unknown,
  {
    surface,
    databaseProperties,
  }: {
    surface: AutomationActionSurface;
    databaseProperties?: readonly DbProperty[];
  },
): AutomationActionDocument {
  const documentLabel = isButtonSurface(surface) ? 'Button action document' : 'Automation action document';
  const actionLabel = isButtonSurface(surface) ? 'Button action' : 'Automation action';
  if (serializedBytes(rawDocument, documentLabel) > MAX_AUTOMATION_DOCUMENT_BYTES) {
    throw validationError(`${documentLabel} must be at most ${MAX_AUTOMATION_DOCUMENT_BYTES} bytes.`);
  }
  const document = recordValue(rawDocument, documentLabel);
  if (document.version !== 1) throw validationError(`${documentLabel} version must be 1.`);
  const label = requiredString(
    document.label,
    isButtonSurface(surface) ? 'Button label' : 'Automation label',
    100,
  );
  if (!Array.isArray(document.actions) || document.actions.length === 0) {
    throw validationError(`${documentLabel} must include at least one action.`);
  }
  if (document.actions.length > MAX_AUTOMATION_ACTIONS) {
    throw validationError(`${documentLabel} must include at most ${MAX_AUTOMATION_ACTIONS} actions.`);
  }

  const propertiesById = new Map((databaseProperties ?? []).map((property) => [property.id, property]));
  const actionIds = new Set<string>();
  const knownVariables = new Set<string>();
  const insertedBlockCount = { value: 0 };
  const actions = document.actions.map((rawAction, index): AutomationAction => {
    const action = recordValue(rawAction, `${actionLabel} ${index + 1}`);
    const id = requiredString(action.id, `${actionLabel} ${index + 1} id`, 160);
    if (actionIds.has(id)) throw validationError(`Duplicate ${actionLabel.toLowerCase()} id: ${id}.`);
    actionIds.add(id);

    if (action.type === 'define_variables') {
      if (
        !Array.isArray(action.variables)
        || action.variables.length === 0
        || action.variables.length > MAX_AUTOMATION_VARIABLES
      ) {
        throw validationError(
          `${actionLabel} ${index + 1} must define 1-${MAX_AUTOMATION_VARIABLES} variables.`,
        );
      }
      const variables = action.variables.map((rawVariable, variableIndex) => {
        const variable = recordValue(
          rawVariable,
          `${actionLabel} ${index + 1} variable ${variableIndex + 1}`,
        );
        const name = requiredString(
          variable.name,
          `${actionLabel} ${index + 1} variable ${variableIndex + 1} name`,
          100,
        );
        if (knownVariables.has(name)) throw validationError(`Duplicate automation variable: ${name}.`);
        const value = normalizeValueExpression(
          variable.value,
          `${actionLabel} ${index + 1} variable ${name}`,
          knownVariables,
          databaseProperties,
        );
        knownVariables.add(name);
        return { name, value };
      });
      return { id, type: 'define_variables', variables };
    }

    if (action.type === 'edit_property') {
      if (surface === 'schedule_automation') {
        throw validationError('Recurring automation actions cannot edit the trigger page property.');
      }
      if (action.target !== 'trigger_page') {
        throw validationError('Property edits must target the trigger page.');
      }
      const propertyId = requiredString(action.propertyId, `${actionLabel} ${index + 1} propertyId`, 160);
      const property = propertiesById.get(propertyId);
      if (databaseProperties) {
        if (!property) throw validationError(`${actionLabel} target property was not found: ${propertyId}.`);
        if (!EDITABLE_SCALAR_TYPES.has(property.type) || (
          property.type !== 'title' && isReadOnlyDatabasePropertyType(property.type)
        )) {
          throw validationError(`${actionLabel} cannot edit property type: ${property.type}.`);
        }
      }
      return {
        id,
        type: 'edit_property',
        target: 'trigger_page',
        propertyId,
        value: property
          ? parseValueExpression(action.value, property, knownVariables, databaseProperties ?? [])
          : normalizeValueExpression(action.value, `${actionLabel} ${index + 1} value`, knownVariables),
      };
    }

    if (action.type === 'insert_blocks') {
      if (surface !== 'page_button') {
        throw validationError('Inserted content is available only to page buttons.');
      }
      if (action.target !== 'trigger_page') {
        throw validationError('Inserted blocks must target the trigger page.');
      }
      if (!Array.isArray(action.blocks) || action.blocks.length === 0) {
        throw validationError('Insert-block actions must include at least one block.');
      }
      return {
        id,
        type: 'insert_blocks',
        target: 'trigger_page',
        blocks: action.blocks.map((item, blockIndex) => (
          normalizeBlockTemplate(
            item,
            `${actionLabel} ${index + 1} block ${blockIndex + 1}`,
            1,
            insertedBlockCount,
          )
        )),
      };
    }

    if (action.type === 'add_page') {
      if (action.target !== 'database') throw validationError('Added pages must target a database.');
      const openCreatedPage = optionalBoolean(
        action.openCreatedPage,
        `${actionLabel} ${index + 1} openCreatedPage`,
      );
      const properties = action.properties === undefined
        ? undefined
        : normalizePropertyChanges(
            action.properties,
            `${actionLabel} ${index + 1} properties`,
            knownVariables,
          );
      return {
        id,
        type: 'add_page',
        target: 'database',
        databaseId: requiredString(action.databaseId, `${actionLabel} ${index + 1} databaseId`, 160),
        title: normalizeDynamicText(
          action.title,
          `${actionLabel} ${index + 1} title`,
          knownVariables,
          databaseProperties,
        ),
        ...(properties ? { properties } : {}),
        ...(openCreatedPage === undefined ? {} : { openCreatedPage }),
      };
    }

    if (action.type === 'edit_pages') {
      const target = recordValue(action.target, `${actionLabel} ${index + 1} target`);
      if (target.type !== 'database') throw validationError('Edited pages must target a database.');
      const filter = recordValue(target.filter, `${actionLabel} ${index + 1} filter`);
      if (serializedBytes(filter, `${actionLabel} ${index + 1} filter`) > MAX_AUTOMATION_FILTER_BYTES) {
        throw validationError(
          `${actionLabel} ${index + 1} filter must be at most ${MAX_AUTOMATION_FILTER_BYTES} bytes.`,
        );
      }
      if (hasPotentialStoredFileReference(filter)) {
        throw validationError('Automation edit-page filters cannot contain stored file references.');
      }
      if (!Number.isSafeInteger(target.limit) || (target.limit as number) < 1
        || (target.limit as number) > MAX_AUTOMATION_TARGET_ROWS) {
        throw validationError(
          `${actionLabel} ${index + 1} target limit must be 1-${MAX_AUTOMATION_TARGET_ROWS}.`,
        );
      }
      return {
        id,
        type: 'edit_pages',
        target: {
          type: 'database',
          databaseId: requiredString(
            target.databaseId,
            `${actionLabel} ${index + 1} databaseId`,
            160,
          ),
          filter: structuredClone(filter),
          limit: target.limit as number,
        },
        changes: normalizePropertyChanges(
          action.changes,
          `${actionLabel} ${index + 1} changes`,
          knownVariables,
        ),
      };
    }

    if (action.type === 'send_notification') {
      if (
        !Array.isArray(action.recipientIds)
        || action.recipientIds.length === 0
        || action.recipientIds.length > MAX_AUTOMATION_NOTIFICATION_RECIPIENTS
      ) {
        throw validationError(
          `Automation notifications require 1-${MAX_AUTOMATION_NOTIFICATION_RECIPIENTS} recipients.`,
        );
      }
      const recipientIds = action.recipientIds.map((recipientId, recipientIndex) => (
        requiredString(recipientId, `${actionLabel} ${index + 1} recipient ${recipientIndex + 1}`, 160)
      ));
      if (new Set(recipientIds).size !== recipientIds.length) {
        throw validationError('Automation notification recipients must be unique.');
      }
      return {
        id,
        type: 'send_notification',
        recipientIds,
        message: requiredString(action.message, `${actionLabel} ${index + 1} message`, 2_000),
      };
    }

    if (action.type === 'send_email') {
      return {
        id,
        type: 'send_email',
        recipientEmail: normalizedEmail(action.recipientEmail, `${actionLabel} ${index + 1} recipientEmail`),
        subject: requiredString(action.subject, `${actionLabel} ${index + 1} subject`, 200),
        message: requiredString(action.message, `${actionLabel} ${index + 1} message`, 2_000),
      };
    }

    if (action.type === 'send_webhook') {
      const url = normalizePublicUrl(action.url);
      if (!url) throw validationError(`${actionLabel} ${index + 1} URL must be a public HTTP(S) URL.`);
      return {
        id,
        type: 'send_webhook',
        url,
        body: structuredClone(recordValue(action.body, `${actionLabel} ${index + 1} body`)),
      };
    }

    if (action.type === 'send_slack') {
      return {
        id,
        type: 'send_slack',
        connectionId: requiredString(action.connectionId, `${actionLabel} ${index + 1} connectionId`, 160),
        channelId: requiredString(action.channelId, `${actionLabel} ${index + 1} channelId`, 160),
        message: requiredString(action.message, `${actionLabel} ${index + 1} message`, 2_000),
      };
    }

    if (action.type === 'show_confirmation') {
      if (!isButtonSurface(surface)) throw validationError('Confirmation actions are available only to buttons.');
      return {
        id,
        type: 'show_confirmation',
        title: requiredString(action.title, `${actionLabel} ${index + 1} title`, 200),
        message: requiredString(action.message, `${actionLabel} ${index + 1} message`, 2_000),
        confirmLabel: requiredString(action.confirmLabel, `${actionLabel} ${index + 1} confirmLabel`, 100),
        cancelLabel: action.cancelLabel === undefined
          ? 'Cancel'
          : requiredString(action.cancelLabel, `${actionLabel} ${index + 1} cancelLabel`, 100),
      };
    }

    if (action.type === 'open_page') {
      if (!isButtonSurface(surface)) throw validationError('Page-navigation actions are available only to buttons.');
      return {
        id,
        type: 'open_page',
        pageId: requiredString(action.pageId, `${actionLabel} ${index + 1} pageId`, 160),
      };
    }

    if (action.type === 'open_form') {
      if (!isButtonSurface(surface)) throw validationError('Form-navigation actions are available only to buttons.');
      return {
        id,
        type: 'open_form',
        databaseId: requiredString(action.databaseId, `${actionLabel} ${index + 1} databaseId`, 160),
        viewId: requiredString(action.viewId, `${actionLabel} ${index + 1} viewId`, 160),
      };
    }

    if (action.type === 'open_url') {
      if (!isButtonSurface(surface)) throw validationError('URL-navigation actions are available only to buttons.');
      const url = normalizePublicUrl(action.url);
      if (!url) throw validationError(`${actionLabel} ${index + 1} URL must be a public HTTP(S) URL.`);
      return { id, type: 'open_url', url };
    }

    throw validationError(`Unsupported ${actionLabel.toLowerCase()} type: ${String(action.type)}.`);
  });
  return { version: 1, label, actions };
}

export function databaseButtonActionDocument(
  property: DbProperty,
  databaseProperties: readonly DbProperty[],
): DatabaseButtonActionDocument | null {
  if (property.type !== 'button') return null;
  const rawButton = property.config?.button;
  if (rawButton === undefined || rawButton === null) return null;
  return normalizeAutomationActionDocument(rawButton, {
    surface: 'database_button',
    databaseProperties,
  });
}

function databaseAutomationEventActionDocument(
  rawDocument: unknown,
  databaseProperties: readonly DbProperty[],
): AutomationActionDocument {
  return normalizeAutomationActionDocument(rawDocument, {
    surface: 'event_automation',
    databaseProperties,
  });
}

function normalizedEmail(value: unknown, label: string) {
  const email = requiredString(value, label, 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw validationError(`${label} must be a valid email address.`);
  }
  return email;
}

export function databaseAutomationScheduleActionDocument(
  rawDocument: unknown,
): DatabaseAutomationScheduleActionDocument {
  return normalizeAutomationActionDocument(rawDocument, {
    surface: 'schedule_automation',
  }) as DatabaseAutomationScheduleActionDocument;
}

export function databaseAutomationDefinitionDocument(
  rawDefinition: unknown,
  databaseProperties: readonly DbProperty[],
): DatabaseAutomationDefinitionDocument {
  if (serializedBytes(rawDefinition, 'Database automation definition') > MAX_AUTOMATION_DOCUMENT_BYTES) {
    throw validationError(`Database automation definition must be at most ${MAX_AUTOMATION_DOCUMENT_BYTES} bytes.`);
  }
  const definition = recordValue(rawDefinition, 'Database automation definition');
  const name = requiredString(definition.name, 'Automation name', 100);
  const enabled = requiredBoolean(definition.enabled, 'Automation enabled');

  const rawScope = recordValue(definition.scope, 'Automation scope');
  const scope = rawScope.type === 'database'
    ? { type: 'database' as const }
    : rawScope.type === 'view'
      ? {
          type: 'view' as const,
          viewId: requiredString(rawScope.viewId, 'Automation viewId', 160),
        }
      : (() => { throw validationError('Automation scope type must be database or view.'); })();

  const rawTrigger = recordValue(definition.trigger, 'Automation trigger');
  if (rawTrigger.type === 'schedule') {
    if (rawTrigger.frequency !== 'daily') {
      throw validationError('This automation slice only supports daily recurring schedules.');
    }
    if (!Number.isSafeInteger(rawTrigger.interval) || (rawTrigger.interval as number) < 1
      || (rawTrigger.interval as number) > 365) {
      throw validationError('Automation daily interval must be an integer from 1 to 365.');
    }
    const time = requiredString(rawTrigger.time, 'Automation schedule time', 5);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
    if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) {
      throw validationError('Automation schedule time must use 24-hour HH:mm format.');
    }
    const timeZone = requiredString(rawTrigger.timeZone, 'Automation schedule timeZone', 160);
    if (!validScheduleTimeZone(timeZone)) {
      throw validationError('Automation schedule timeZone must be a valid IANA timezone.');
    }
    const startsOn = requiredString(rawTrigger.startsOn, 'Automation schedule startsOn', 10);
    if (!validScheduleDate(startsOn)) {
      throw validationError('Automation schedule startsOn must be a valid YYYY-MM-DD date.');
    }
    const endsOn = rawTrigger.endsOn === undefined
      ? undefined
      : requiredString(rawTrigger.endsOn, 'Automation schedule endsOn', 10);
    if (endsOn && (!validScheduleDate(endsOn) || endsOn < startsOn)) {
      throw validationError('Automation schedule endsOn must be on or after startsOn.');
    }
    return {
      name,
      enabled,
      scope,
      trigger: {
        type: 'schedule',
        frequency: 'daily',
        interval: rawTrigger.interval as number,
        time,
        timeZone,
        startsOn,
        ...(endsOn ? { endsOn } : {}),
      },
      actionDocument: databaseAutomationScheduleActionDocument(definition.actionDocument),
    };
  }
  if (rawTrigger.type !== 'events') throw validationError('Automation trigger type must be events.');
  if (rawTrigger.mode !== 'any' && rawTrigger.mode !== 'all') {
    throw validationError('Automation trigger mode must be any or all.');
  }
  if (!Array.isArray(rawTrigger.conditions) || rawTrigger.conditions.length === 0) {
    throw validationError('Automation trigger must include at least one condition.');
  }
  if (rawTrigger.conditions.length > MAX_AUTOMATION_TRIGGER_CONDITIONS) {
    throw validationError(
      `Automation trigger must include at most ${MAX_AUTOMATION_TRIGGER_CONDITIONS} conditions.`,
    );
  }
  const propertyIds = new Set(databaseProperties.map((property) => property.id));
  const conditionKeys = new Set<string>();
  const conditions = rawTrigger.conditions.map((rawCondition, index): DatabaseAutomationEventCondition => {
    const condition = recordValue(rawCondition, `Automation trigger condition ${index + 1}`);
    if (condition.type === 'row_added') {
      if (rawTrigger.mode === 'all') {
        throw validationError('All-of automation triggers may only contain property edits.');
      }
      if (conditionKeys.has('row_added')) throw validationError('Duplicate row-added trigger condition.');
      conditionKeys.add('row_added');
      return { type: 'row_added' };
    }
    if (condition.type !== 'property_edited') {
      throw validationError(`Unsupported automation trigger condition: ${String(condition.type)}.`);
    }
    const propertyId = requiredString(
      condition.propertyId,
      `Automation trigger condition ${index + 1} propertyId`,
      160,
    );
    if (!propertyIds.has(propertyId)) {
      throw validationError(`Automation trigger property was not found: ${propertyId}.`);
    }
    const key = `property:${propertyId}`;
    if (conditionKeys.has(key)) throw validationError(`Duplicate automation trigger property: ${propertyId}.`);
    conditionKeys.add(key);
    return { type: 'property_edited', propertyId };
  });
  if (rawTrigger.mode === 'all' && conditions.length < 2) {
    throw validationError('All-of automation triggers require at least two property conditions.');
  }

  return {
    name,
    enabled,
    scope,
    trigger: { type: 'events', mode: rawTrigger.mode, conditions },
    actionDocument: databaseAutomationEventActionDocument(
      definition.actionDocument,
      databaseProperties,
    ),
  };
}

export function pageButtonActionDocument(block: Block): AutomationActionDocument | null {
  if (block.type !== 'button') return null;
  const rawDocument = block.content?.buttonActionDocument;
  const legacyTemplates = block.content?.buttonTemplate;
  const rawButton = rawDocument ?? (
    Array.isArray(legacyTemplates) && legacyTemplates.length > 0
      ? {
          version: 1,
          label: block.content?.buttonLabel ?? block.plainText ?? 'Button',
          actions: [{
            id: 'legacy-insert-blocks',
            type: 'insert_blocks',
            target: 'trigger_page',
            blocks: legacyTemplates,
          }],
        }
      : null
  );
  if (rawButton === null || rawButton === undefined) return null;
  return normalizeAutomationActionDocument(rawButton, {
    surface: 'page_button',
  });
}

export function assertDatabaseButtonConfiguration(
  property: DbProperty,
  databaseProperties: readonly DbProperty[],
) {
  databaseButtonActionDocument(property, databaseProperties);
}

export function applyTriggerPagePropertyActions(
  document: DatabaseButtonActionDocument,
  databaseProperties: readonly DbProperty[],
  current: { title?: string; properties?: Record<string, unknown> },
  executionTime: string,
) {
  const propertiesById = new Map(databaseProperties.map((property) => [property.id, property]));
  const nextProperties = structuredClone(current.properties ?? {});
  let nextTitle = current.title ?? '';
  const changedPropertyIds = new Set<string>();
  const context: AutomationValueContext = {
    databaseProperties,
    executionTime,
    triggerPage: { title: nextTitle, properties: nextProperties },
    variables: new Map(),
  };

  for (const action of document.actions) {
    if (action.type === 'define_variables') {
      applyAutomationVariableDefinitions(action, context);
      continue;
    }
    if (action.type !== 'edit_property') {
      throw validationError(`Automation action type is not executable in the property-edit runner: ${action.type}.`);
    }
    const property = propertiesById.get(action.propertyId);
    if (!property) throw validationError(`Button action target property was not found: ${action.propertyId}.`);
    const value = evaluateAutomationPropertyValue(property, action.value, context);
    if (property.type === 'title') nextTitle = String(value ?? '');
    else nextProperties[property.id] = value;
    context.triggerPage = { title: nextTitle, properties: nextProperties };
    changedPropertyIds.add(property.id);
  }

  return {
    changedPropertyIds: Array.from(changedPropertyIds),
    properties: nextProperties,
    title: nextTitle,
  };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export async function automationRequestHash(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(value)));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function assertAutomationResultBound(value: unknown) {
  if (serializedBytes(value, 'Automation result') > MAX_AUTOMATION_RESULT_BYTES) {
    throw validationError(`Automation result must be at most ${MAX_AUTOMATION_RESULT_BYTES} bytes.`);
  }
}
