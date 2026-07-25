import type {
  DbProperty,
  FormViewConfig,
  FormViewQuestion,
  PropertyType,
} from "./types";

export const FORM_VIEW_MAX_QUESTIONS = 50;
export const FORM_VIEW_MAX_SELECTIONS = 50;
export const FORM_VIEW_MAX_REFERENCE_SELECTIONS = 50;

export const FORM_VIEW_WRITABLE_PROPERTY_TYPES = [
  "title",
  "rich_text",
  "number",
  "select",
  "multi_select",
  "status",
  "date",
  "checkbox",
  "url",
  "email",
  "phone",
  "person",
  "relation",
] as const satisfies readonly PropertyType[];

const writableTypes = new Set<PropertyType>(FORM_VIEW_WRITABLE_PROPERTY_TYPES);

export function isFormViewProperty(
  property: Pick<DbProperty, "type">,
): boolean {
  return writableTypes.has(property.type);
}

export function createFormQuestion(
  property: DbProperty,
  position: number,
): FormViewQuestion {
  return {
    id: `question:${property.id}`,
    propertyId: property.id,
    label: property.name || property.id,
    description: property.description ?? "",
    required: false,
    hidden: false,
    syncWithPropertyName: true,
    ...(property.type === "rich_text" ? { longAnswer: false } : {}),
    ...(property.type === "select" || property.type === "status" || property.type === "multi_select"
      ? { optionsDisplay: "list" as const }
      : {}),
    ...(property.type === "multi_select" || property.type === "person" || property.type === "relation"
      ? { maxSelections: FORM_VIEW_MAX_SELECTIONS }
      : {}),
    position,
  };
}

export function createDefaultFormViewConfig(
  properties: DbProperty[],
  overrides: Partial<Pick<FormViewConfig, "title" | "description" | "icon" | "cover">> = {},
): FormViewConfig {
  const questions = properties
    .filter(isFormViewProperty)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .slice(0, FORM_VIEW_MAX_QUESTIONS)
    .map(createFormQuestion);
  return {
    version: 1,
    title: overrides.title ?? "",
    description: overrides.description ?? "",
    icon: overrides.icon ?? "",
    cover: overrides.cover ?? "",
    questions,
    submit: {
      buttonLabel: "Submit",
      confirmationTitle: "Thanks for your response",
      confirmationBody: "",
      buttonColor: "blue",
    },
  };
}

export function formRequiresWorkspaceAudience(
  form: FormViewConfig,
  properties: Array<Pick<DbProperty, "id" | "type">>,
) {
  const byId = new Map(properties.map((property) => [property.id, property]));
  return form.questions.some((question) => {
    const type = byId.get(question.propertyId)?.type;
    return type === "person" || type === "relation";
  });
}

function normalizedText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function buildFormSubmissionAnswers(
  form: FormViewConfig,
  properties: Array<Pick<DbProperty, "id" | "type">>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const propertiesById = new Map(properties.map((property) => [property.id, property]));
  const answers: Record<string, unknown> = {};
  for (const question of form.questions) {
    if (question.hidden) continue;
    const property = propertiesById.get(question.propertyId);
    if (!property || !writableTypes.has(property.type)) continue;
    const raw = values[property.id];
    if (property.type === "checkbox") {
      if (typeof raw === "boolean") answers[property.id] = raw;
      continue;
    }
    if (property.type === "number") {
      if (raw === "" || raw === undefined || raw === null) continue;
      const number = typeof raw === "number" ? raw : Number(normalizedText(raw));
      if (Number.isFinite(number)) answers[property.id] = number;
      continue;
    }
    if (property.type === "multi_select" || property.type === "person" || property.type === "relation") {
      if (!Array.isArray(raw)) continue;
      const ids = raw
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value, index, all) => value.length > 0 && all.indexOf(value) === index)
        .slice(0, question.maxSelections ?? FORM_VIEW_MAX_SELECTIONS);
      if (ids.length > 0) answers[property.id] = ids;
      continue;
    }
    const text = normalizedText(raw);
    if (text) answers[property.id] = text;
  }
  return answers;
}

export function formQuestionLabel(
  question: FormViewQuestion,
  property: Pick<DbProperty, "id" | "name"> | undefined,
) {
  return question.syncWithPropertyName
    ? property?.name || property?.id || question.label
    : question.label;
}

export function formHref(token: string) {
  return `/form/${encodeURIComponent(token)}`;
}

export function absoluteFormUrl(token: string) {
  const href = formHref(token);
  return typeof window === "undefined" ? href : new URL(href, window.location.origin).toString();
}
