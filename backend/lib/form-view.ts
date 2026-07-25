import type { DbProperty } from './app-types';

export const FORM_VIEW_MAX_QUESTIONS = 50;
export const FORM_VIEW_MAX_SCALAR_BYTES = 8 * 1024;
export const FORM_VIEW_MAX_SELECTIONS = 50;
export const FORM_VIEW_MAX_REFERENCE_SELECTIONS = 50;

const encoder = new TextEncoder();
export const FORM_VIEW_WRITABLE_PROPERTY_TYPES = [
  'title',
  'rich_text',
  'number',
  'select',
  'multi_select',
  'status',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
  'person',
  'relation',
] as const;
const formQuestionPropertyTypes = new Set<string>(FORM_VIEW_WRITABLE_PROPERTY_TYPES);
const multiValuePropertyTypes = new Set(['multi_select', 'person', 'relation']);
const optionDisplayValues = new Set(['list', 'dropdown']);
const buttonColors = new Set(['blue', 'gray', 'green', 'red', 'orange', 'purple']);

export interface FormViewQuestion {
  id: string;
  propertyId: string;
  label: string;
  description: string;
  required: boolean;
  hidden: boolean;
  syncWithPropertyName: boolean;
  longAnswer?: boolean;
  optionsDisplay?: 'list' | 'dropdown';
  maxSelections?: number;
  position: number;
}

export interface FormViewSubmitConfig {
  buttonLabel: string;
  confirmationTitle: string;
  confirmationBody: string;
  buttonColor: 'blue' | 'gray' | 'green' | 'red' | 'orange' | 'purple';
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

export interface FormSubmissionProjection {
  title: string;
  properties: Record<string, unknown>;
}

function formError(message: string, status = 400) {
  return Object.assign(new Error(message), { status });
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw formError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function boundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  fallback = '',
) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') throw formError(`${label} must be a string.`);
  if (encoder.encode(value).byteLength > maxBytes) {
    const kib = maxBytes / 1024;
    throw formError(`${label} must be at most ${kib} KiB.`);
  }
  return value;
}

function booleanValue(value: unknown, fallback: boolean, label: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw formError(`${label} must be a boolean.`);
  return value;
}

function integerValue(
  value: unknown,
  fallback: number | undefined,
  label: string,
  min: number,
  max: number,
) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw formError(`${label} must be an integer from ${min} to ${max}.`);
  }
  return Number(value);
}

export function isFormQuestionProperty(property: DbProperty) {
  return formQuestionPropertyTypes.has(property.type);
}

function defaultQuestion(property: DbProperty, position: number): FormViewQuestion {
  return {
    id: `question:${property.id}`,
    propertyId: property.id,
    label: property.name || property.id,
    description: property.description ?? '',
    required: false,
    hidden: false,
    syncWithPropertyName: true,
    ...(property.type === 'rich_text' ? { longAnswer: false } : {}),
    ...(property.type === 'select' || property.type === 'status' || property.type === 'multi_select'
      ? { optionsDisplay: 'list' as const }
      : {}),
    ...(multiValuePropertyTypes.has(property.type)
      ? { maxSelections: FORM_VIEW_MAX_SELECTIONS }
      : {}),
    position,
  };
}

export function defaultFormViewConfig(
  properties: DbProperty[],
  overrides: Partial<Pick<FormViewConfig, 'title' | 'description' | 'icon' | 'cover'>> = {},
): FormViewConfig {
  const questions = properties
    .filter(isFormQuestionProperty)
    .sort((a, b) => a.position - b.position)
    .map(defaultQuestion);
  if (questions.length > FORM_VIEW_MAX_QUESTIONS) {
    throw formError(`A form may contain at most ${FORM_VIEW_MAX_QUESTIONS} questions.`);
  }
  return {
    version: 1,
    title: boundedString(overrides.title, 'form.title', 512, ''),
    description: boundedString(overrides.description, 'form.description', 2 * 1024, ''),
    icon: boundedString(overrides.icon, 'form.icon', 2 * 1024, ''),
    cover: boundedString(overrides.cover, 'form.cover', 4 * 1024, ''),
    questions,
    submit: {
      buttonLabel: 'Submit',
      confirmationTitle: 'Thanks for your response',
      confirmationBody: '',
      buttonColor: 'blue',
    },
  };
}

function normalizedQuestion(
  value: unknown,
  index: number,
  propertiesById: Map<string, DbProperty>,
): FormViewQuestion {
  const record = recordValue(value, `form.questions[${index}]`);
  const propertyId = boundedString(
    record.propertyId,
    `form.questions[${index}].propertyId`,
    512,
  ).trim();
  if (!propertyId) throw formError(`form.questions[${index}].propertyId is required.`);
  const property = propertiesById.get(propertyId);
  if (!property) throw formError(`Form question references an unknown property: ${propertyId}.`);
  if (!isFormQuestionProperty(property)) {
    throw formError(`Form question property ${propertyId} is not writable.`);
  }
  const syncWithPropertyName = booleanValue(
    record.syncWithPropertyName,
    true,
    `form.questions[${index}].syncWithPropertyName`,
  );
  const hidden = booleanValue(record.hidden, false, `form.questions[${index}].hidden`);
  const required = booleanValue(record.required, false, `form.questions[${index}].required`);
  if (hidden && required) throw formError(`Hidden form question ${propertyId} cannot be required.`);
  const longAnswer = property.type === 'rich_text'
    ? booleanValue(record.longAnswer, false, `form.questions[${index}].longAnswer`)
    : undefined;
  let optionsDisplay: FormViewQuestion['optionsDisplay'];
  if (property.type === 'select' || property.type === 'status' || property.type === 'multi_select') {
    const raw = record.optionsDisplay ?? 'list';
    if (typeof raw !== 'string' || !optionDisplayValues.has(raw)) {
      throw formError(`form.questions[${index}].optionsDisplay must be list or dropdown.`);
    }
    optionsDisplay = raw as FormViewQuestion['optionsDisplay'];
  }
  const maxSelections = multiValuePropertyTypes.has(property.type)
    ? integerValue(
        record.maxSelections,
        FORM_VIEW_MAX_SELECTIONS,
        `form.questions[${index}].maxSelections`,
        1,
        FORM_VIEW_MAX_SELECTIONS,
      )
    : undefined;
  return {
    id: boundedString(
      record.id,
      `form.questions[${index}].id`,
      512,
      `question:${propertyId}`,
    ),
    propertyId,
    label: syncWithPropertyName
      ? property.name || property.id
      : boundedString(record.label, `form.questions[${index}].label`, 512, property.name || property.id),
    description: boundedString(
      record.description,
      `form.questions[${index}].description`,
      2 * 1024,
      '',
    ),
    required,
    hidden,
    syncWithPropertyName,
    ...(longAnswer !== undefined ? { longAnswer } : {}),
    ...(optionsDisplay !== undefined ? { optionsDisplay } : {}),
    ...(maxSelections !== undefined ? { maxSelections } : {}),
    position: integerValue(
      record.position,
      index,
      `form.questions[${index}].position`,
      0,
      FORM_VIEW_MAX_QUESTIONS - 1,
    ) ?? index,
  };
}

export function parseFormViewConfig(
  value: unknown,
  properties: DbProperty[],
): FormViewConfig {
  const record = recordValue(value, 'form');
  if (record.version !== 1) throw formError('form.version must be 1.');
  if (!Array.isArray(record.questions)) throw formError('form.questions must be an array.');
  if (record.questions.length > FORM_VIEW_MAX_QUESTIONS) {
    throw formError(`A form may contain at most ${FORM_VIEW_MAX_QUESTIONS} questions.`);
  }
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const questions = record.questions.map((question, index) => (
    normalizedQuestion(question, index, propertiesById)
  ));
  const seenPropertyIds = new Set<string>();
  const seenQuestionIds = new Set<string>();
  for (const question of questions) {
    if (seenPropertyIds.has(question.propertyId)) {
      throw formError(`Form contains a duplicate property question: ${question.propertyId}.`);
    }
    if (seenQuestionIds.has(question.id)) {
      throw formError(`Form contains a duplicate question id: ${question.id}.`);
    }
    seenPropertyIds.add(question.propertyId);
    seenQuestionIds.add(question.id);
  }
  const submitRecord = record.submit === undefined
    ? {}
    : recordValue(record.submit, 'form.submit');
  const buttonColor = submitRecord.buttonColor ?? 'blue';
  if (typeof buttonColor !== 'string' || !buttonColors.has(buttonColor)) {
    throw formError('form.submit.buttonColor is unsupported.');
  }
  return {
    version: 1,
    title: boundedString(record.title, 'form.title', 512, ''),
    description: boundedString(record.description, 'form.description', 2 * 1024, ''),
    icon: boundedString(record.icon, 'form.icon', 2 * 1024, ''),
    cover: boundedString(record.cover, 'form.cover', 4 * 1024, ''),
    questions: questions
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
      .map((question, index) => ({ ...question, position: index })),
    submit: {
      buttonLabel: boundedString(submitRecord.buttonLabel, 'form.submit.buttonLabel', 512, 'Submit'),
      confirmationTitle: boundedString(
        submitRecord.confirmationTitle,
        'form.submit.confirmationTitle',
        512,
        'Thanks for your response',
      ),
      confirmationBody: boundedString(
        submitRecord.confirmationBody,
        'form.submit.confirmationBody',
        2 * 1024,
        '',
      ),
      buttonColor: buttonColor as FormViewSubmitConfig['buttonColor'],
    },
  };
}

function isEmptyAnswer(value: unknown) {
  return value === undefined
    || value === null
    || value === ''
    || (Array.isArray(value) && value.length === 0);
}

function optionIds(property: DbProperty) {
  const options = Array.isArray(property.config?.options) ? property.config.options : [];
  return new Set(options.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const id = (value as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  }));
}

function validIsoDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function scalarString(value: unknown, label: string) {
  return boundedString(value, label, FORM_VIEW_MAX_SCALAR_BYTES);
}

function normalizedIds(value: unknown, question: FormViewQuestion, label: string) {
  if (!Array.isArray(value)) throw formError(`${label} must be an array.`);
  const ids = value.map((item) => scalarString(item, label).trim());
  if (ids.some((id) => !id)) throw formError(`${label} contains an empty selection.`);
  if (new Set(ids).size !== ids.length) throw formError(`${label} contains duplicate selections.`);
  const maxSelections = question.maxSelections ?? FORM_VIEW_MAX_SELECTIONS;
  if (ids.length > maxSelections) {
    throw formError(`${label} may contain at most ${maxSelections} selections.`);
  }
  return ids;
}

function normalizeAnswer(
  property: DbProperty,
  question: FormViewQuestion,
  value: unknown,
) {
  const label = `answer for ${question.propertyId}`;
  if (property.type === 'title' || property.type === 'rich_text') {
    return scalarString(value, label);
  }
  if (property.type === 'url') {
    const text = scalarString(value, label);
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      throw formError(`${label} must be a valid URL.`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw formError(`${label} must be a valid http(s) URL.`);
    }
    return text;
  }
  if (property.type === 'email') {
    const text = scalarString(value, label);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
      throw formError(`${label} must be a valid email address.`);
    }
    return text;
  }
  if (property.type === 'phone') return scalarString(value, label);
  if (property.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw formError(`${label} must be a finite number.`);
    }
    return value;
  }
  if (property.type === 'checkbox') {
    if (typeof value !== 'boolean') throw formError(`${label} must be a boolean.`);
    return value;
  }
  if (property.type === 'date') {
    const text = scalarString(value, label);
    if (!validIsoDate(text)) throw formError(`${label} must be a valid ISO date.`);
    return text;
  }
  if (property.type === 'select' || property.type === 'status') {
    const id = scalarString(value, label);
    if (!optionIds(property).has(id)) throw formError(`${label} contains an unknown option.`);
    return id;
  }
  if (property.type === 'multi_select') {
    const ids = normalizedIds(value, question, label);
    const allowed = optionIds(property);
    if (ids.some((id) => !allowed.has(id))) {
      throw formError(`${label} contains an unknown option.`);
    }
    return ids;
  }
  if (property.type === 'person' || property.type === 'relation') {
    return normalizedIds(value, question, label);
  }
  if (property.type === 'files') {
    throw formError(`${label} requires the form file-submission path.`);
  }
  throw formError(`Form question property ${question.propertyId} is not writable.`);
}

export function normalizeFormSubmission(
  config: FormViewConfig,
  properties: DbProperty[],
  answersValue: unknown,
): FormSubmissionProjection {
  const answers = recordValue(answersValue, 'answers');
  const questionsByPropertyId = new Map(config.questions.map((question) => [question.propertyId, question]));
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  for (const propertyId of Object.keys(answers)) {
    const question = questionsByPropertyId.get(propertyId);
    if (!question) throw formError(`Answer references an unknown form question: ${propertyId}.`);
    if (question.hidden) throw formError(`Answer references a hidden form question: ${propertyId}.`);
  }

  let title = '';
  let referenceSelectionCount = 0;
  const projectedProperties: Record<string, unknown> = {};
  for (const question of config.questions) {
    if (question.hidden) continue;
    const value = answers[question.propertyId];
    if (isEmptyAnswer(value)) {
      if (question.required) throw formError(`Answer for ${question.propertyId} is required.`);
      continue;
    }
    const property = propertiesById.get(question.propertyId);
    if (!property || !isFormQuestionProperty(property)) {
      throw formError(`Form question property ${question.propertyId} is no longer writable.`, 409);
    }
    const normalized = normalizeAnswer(property, question, value);
    if (property.type === 'person' || property.type === 'relation') {
      referenceSelectionCount += (normalized as string[]).length;
      if (referenceSelectionCount > FORM_VIEW_MAX_REFERENCE_SELECTIONS) {
        throw formError(
          `A form response may contain at most ${FORM_VIEW_MAX_REFERENCE_SELECTIONS} person and relation selections.`,
        );
      }
    }
    if (property.type === 'title') title = normalized as string;
    else projectedProperties[property.id] = normalized;
  }
  return { title, properties: projectedProperties };
}
