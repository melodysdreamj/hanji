"use client";

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash } from "@/icons/hanji";
import { newId } from "@/lib/ids";
import type {
  AddPageAutomationAction,
  AutomationAction,
  AutomationValueExpression,
  DbProperty,
  DbView,
  EditPropertyAutomationAction,
  Page,
} from "@/lib/types";
import styles from "./automationActionEditor.module.css";

export type AutomationEditorSurface =
  | "database_button"
  | "page_button"
  | "event_automation"
  | "schedule_automation";

export type AutomationActionType = AutomationAction["type"];

const BUTTON_ACTION_TYPES: AutomationActionType[] = [
  "edit_property",
  "add_page",
  "edit_pages",
  "send_notification",
  "show_confirmation",
  "open_page",
  "open_form",
  "open_url",
  "define_variables",
  "send_email",
  "send_webhook",
  "send_slack",
];

const EVENT_ACTION_TYPES: AutomationActionType[] = [
  "edit_property",
  "add_page",
  "edit_pages",
  "send_notification",
  "define_variables",
  "send_email",
  "send_webhook",
  "send_slack",
];

export function automationActionTypesForSurface(surface: AutomationEditorSurface) {
  if (surface === "page_button") return ["insert_blocks" as const, ...BUTTON_ACTION_TYPES];
  if (surface === "database_button") return BUTTON_ACTION_TYPES;
  if (surface === "schedule_automation") {
    return EVENT_ACTION_TYPES.filter((type) => type !== "edit_property");
  }
  return EVENT_ACTION_TYPES;
}

function defaultPropertyValue(property?: DbProperty): AutomationValueExpression {
  if (property?.type === "date") return { kind: "execution_time" };
  if (property?.type === "checkbox") return { kind: "literal", value: false };
  if (property?.type === "multi_select" || property?.type === "person") {
    return { kind: "literal", value: [] };
  }
  if (property?.type === "number" || property?.type === "select" || property?.type === "status" || property?.type === "place") {
    return { kind: "literal", value: null };
  }
  if (property?.type === "verification") {
    return { kind: "literal", value: { state: "unverified" } };
  }
  return { kind: "literal", value: "" };
}

function databasePages(pages: readonly Page[]) {
  return pages.filter((page) => page.kind === "database" && !page.inTrash);
}

export function newAutomationEditorAction(
  type: AutomationActionType,
  {
    properties,
    pages,
    views,
    userId,
  }: {
    properties: readonly DbProperty[];
    pages: readonly Page[];
    views: readonly DbView[];
    userId?: string;
  },
): AutomationAction {
  const property = properties[0];
  const database = databasePages(pages)[0];
  if (type === "edit_property") {
    return {
      id: newId(),
      type,
      target: "trigger_page",
      propertyId: property?.id ?? "",
      value: defaultPropertyValue(property),
    };
  }
  if (type === "insert_blocks") {
    return {
      id: newId(),
      type,
      target: "trigger_page",
      blocks: [{ type: "paragraph", content: { rich: [] } }],
    };
  }
  if (type === "add_page") {
    return {
      id: newId(),
      type,
      target: "database",
      databaseId: database?.id ?? "",
      title: "",
      openCreatedPage: false,
    };
  }
  if (type === "edit_pages") {
    return {
      id: newId(),
      type,
      target: { type: "database", databaseId: database?.id ?? "", filter: {}, limit: 100 },
      changes: property ? [{ propertyId: property.id, value: defaultPropertyValue(property) }] : [],
    };
  }
  if (type === "define_variables") {
    return {
      id: newId(),
      type,
      variables: [{ name: "variable", value: { kind: "formula", expression: "" } }],
    };
  }
  if (type === "send_notification") {
    return { id: newId(), type, recipientIds: userId ? [userId] : [], message: "" };
  }
  if (type === "send_email") {
    return { id: newId(), type, recipientEmail: "", subject: "", message: "" };
  }
  if (type === "send_webhook") {
    return { id: newId(), type, url: "", body: {} };
  }
  if (type === "send_slack") {
    return { id: newId(), type, connectionId: "", channelId: "", message: "" };
  }
  if (type === "show_confirmation") {
    return {
      id: newId(),
      type,
      title: "Confirm action",
      message: "Continue?",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
    };
  }
  if (type === "open_page") {
    return { id: newId(), type, pageId: pages.find((page) => !page.inTrash)?.id ?? "" };
  }
  if (type === "open_form") {
    return {
      id: newId(),
      type,
      databaseId: database?.id ?? "",
      viewId: views.find((view) => view.type === "form")?.id ?? views[0]?.id ?? "",
    };
  }
  return { id: newId(), type: "open_url", url: "" };
}

function expressionValid(value: AutomationValueExpression, knownVariables: ReadonlySet<string>) {
  if (value.kind === "formula") return Boolean(value.expression.trim());
  if (value.kind === "variable") return knownVariables.has(value.name);
  if (value.kind === "trigger_property") return Boolean(value.propertyId);
  return true;
}

export function automationEditorActionsValid(
  actions: readonly AutomationAction[],
  surface: AutomationEditorSurface,
) {
  if (actions.length === 0 || actions.length > 20) return false;
  const allowed = new Set(automationActionTypesForSurface(surface));
  const knownVariables = new Set<string>();
  for (const action of actions) {
    if (!allowed.has(action.type)) return false;
    if (action.type === "define_variables") {
      if (!action.variables.length) return false;
      for (const variable of action.variables) {
        if (!variable.name.trim() || knownVariables.has(variable.name) || !expressionValid(variable.value, knownVariables)) {
          return false;
        }
        knownVariables.add(variable.name);
      }
      continue;
    }
    if (action.type === "edit_property") {
      if (!action.propertyId || !expressionValid(action.value, knownVariables)) return false;
    } else if (action.type === "insert_blocks") {
      if (!action.blocks.length) return false;
    } else if (action.type === "add_page") {
      const titleValid = typeof action.title === "string"
        ? Boolean(action.title.trim())
        : expressionValid(action.title, knownVariables);
      if (!action.databaseId || !titleValid) return false;
    } else if (action.type === "edit_pages") {
      if (!action.target.databaseId || action.target.limit < 1 || action.target.limit > 100 || !action.changes.length) {
        return false;
      }
      if (action.changes.some((change) => !change.propertyId || !expressionValid(change.value, knownVariables))) {
        return false;
      }
    } else if (action.type === "send_notification") {
      if (!action.recipientIds.length || action.recipientIds.length > 20 || !action.message.trim()) return false;
    } else if (action.type === "send_email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(action.recipientEmail) || !action.subject.trim() || !action.message.trim()) {
        return false;
      }
    } else if (action.type === "send_webhook") {
      if (!publicHttpUrl(action.url)) return false;
    } else if (action.type === "send_slack") {
      if (!action.connectionId.trim() || !action.channelId.trim() || !action.message.trim()) return false;
    } else if (action.type === "show_confirmation") {
      if (
        !action.title.trim()
        || !action.message.trim()
        || !action.confirmLabel.trim()
        || !action.cancelLabel.trim()
      ) return false;
    } else if (action.type === "open_page") {
      if (!action.pageId) return false;
    } else if (action.type === "open_form") {
      if (!action.databaseId || !action.viewId) return false;
    } else if (!publicHttpUrl(action.url)) {
      return false;
    }
  }
  return true;
}

function publicHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function labelKey(type: AutomationActionType) {
  return `databaseView:actionTypes.${type}`;
}

export function AutomationActionEditor({
  surface,
  actions,
  properties = [],
  pages = [],
  views = [],
  userId,
  onChange,
}: {
  surface: AutomationEditorSurface;
  actions: AutomationAction[];
  properties?: DbProperty[];
  pages?: Page[];
  views?: DbView[];
  userId?: string;
  onChange: (actions: AutomationAction[]) => void;
}) {
  const { t } = useTranslation(["databaseView"]);
  const [menuOpen, setMenuOpen] = useState(false);
  const allowedTypes = useMemo(() => automationActionTypesForSurface(surface), [surface]);
  const databases = useMemo(() => databasePages(pages), [pages]);

  function replace(actionId: string, next: AutomationAction) {
    onChange(actions.map((action) => action.id === actionId ? next : action));
  }

  function add(type: AutomationActionType) {
    onChange([...actions, newAutomationEditorAction(type, { properties, pages, views, userId })]);
    setMenuOpen(false);
  }

  return (
    <div className={styles.root}>
      <div className={styles.list}>
        {actions.map((action, index) => (
          <section key={action.id} className={styles.card}>
            <header>
              <strong>{t(labelKey(action.type))}</strong>
              <button
                type="button"
                aria-label={t("databaseView:removeAction", { number: index + 1 })}
                onClick={() => onChange(actions.filter((candidate) => candidate.id !== action.id))}
              >
                <Trash size={14} aria-hidden="true" />
              </button>
            </header>
            <ActionFields
              action={action}
              index={index}
              properties={properties}
              pages={pages}
              databases={databases}
              views={views}
              onChange={(next) => replace(action.id, next)}
            />
          </section>
        ))}
      </div>
      <div className={styles.addWrap}>
        <button
          type="button"
          className={styles.addButton}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          disabled={actions.length >= 20}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Plus size={15} aria-hidden="true" />
          {t("databaseView:addAction")}
        </button>
        {menuOpen && (
          <div className={styles.menu} role="menu" aria-label={t("databaseView:actionType")}>
            {allowedTypes.map((type) => (
              <button key={type} type="button" role="menuitem" onClick={() => add(type)}>
                {t(labelKey(type))}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActionFields({
  action,
  index,
  properties,
  pages,
  databases,
  views,
  onChange,
}: {
  action: AutomationAction;
  index: number;
  properties: DbProperty[];
  pages: Page[];
  databases: Page[];
  views: DbView[];
  onChange: (action: AutomationAction) => void;
}) {
  const { t } = useTranslation(["databaseView"]);
  const number = index + 1;

  if (action.type === "edit_property") {
    return (
      <>
        <select
          aria-label={t("databaseView:propertyForAction", { number })}
          value={action.propertyId}
          onChange={(event) => {
            const property = properties.find((candidate) => candidate.id === event.target.value);
            onChange({ ...action, propertyId: event.target.value, value: defaultPropertyValue(property) });
          }}
        >
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
        <PropertyValueField action={action} number={number} properties={properties} onChange={onChange} />
      </>
    );
  }

  if (action.type === "insert_blocks") {
    return <p>{t("databaseView:insertContentConfigured")}</p>;
  }

  if (action.type === "add_page") {
    return (
      <>
        <select
          aria-label={t("databaseView:targetDatabaseForAction", { number })}
          value={action.databaseId}
          onChange={(event) => onChange({ ...action, databaseId: event.target.value })}
        >
          {databases.map((database) => <option key={database.id} value={database.id}>{database.title}</option>)}
        </select>
        <input
          aria-label={t("databaseView:pageTitleForAction", { number })}
          value={typeof action.title === "string" ? action.title : ""}
          onChange={(event) => onChange({ ...action, title: event.target.value })}
        />
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            checked={Boolean(action.openCreatedPage)}
            onChange={(event) => onChange({ ...action, openCreatedPage: event.target.checked })}
          />
          {t("databaseView:openCreatedPage")}
        </label>
      </>
    );
  }

  if (action.type === "edit_pages") {
    const change = action.changes[0];
    return (
      <>
        <select
          aria-label={t("databaseView:targetDatabaseForAction", { number })}
          value={action.target.databaseId}
          onChange={(event) => onChange({ ...action, target: { ...action.target, databaseId: event.target.value } })}
        >
          {databases.map((database) => <option key={database.id} value={database.id}>{database.title}</option>)}
        </select>
        <textarea
          aria-label={t("databaseView:filterForAction", { number })}
          value={JSON.stringify(action.target.filter)}
          onChange={(event) => {
            try {
              const filter = JSON.parse(event.target.value) as Record<string, unknown>;
              onChange({ ...action, target: { ...action.target, filter } });
            } catch {
              // Keep the last valid bounded filter while the user is typing.
            }
          }}
        />
        <input
          type="number"
          min={1}
          max={100}
          aria-label={t("databaseView:rowLimitForAction", { number })}
          value={action.target.limit}
          onChange={(event) => onChange({
            ...action,
            target: { ...action.target, limit: Number(event.target.value) || 1 },
          })}
        />
        <select
          aria-label={t("databaseView:propertyForAction", { number })}
          value={change?.propertyId ?? ""}
          onChange={(event) => {
            const property = properties.find((candidate) => candidate.id === event.target.value);
            onChange({
              ...action,
              changes: [{ propertyId: event.target.value, value: defaultPropertyValue(property) }],
            });
          }}
        >
          {properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
        </select>
      </>
    );
  }

  if (action.type === "define_variables") {
    const variable = action.variables[0];
    const expression = variable?.value.kind === "formula" ? variable.value.expression : "";
    return (
      <>
        <input
          aria-label={t("databaseView:variableNameForAction", { number })}
          value={variable?.name ?? ""}
          onChange={(event) => onChange({
            ...action,
            variables: [{ name: event.target.value, value: variable?.value ?? { kind: "formula", expression: "" } }],
          })}
        />
        <input
          aria-label={t("databaseView:formulaForAction", { number })}
          value={expression}
          onChange={(event) => onChange({
            ...action,
            variables: [{ name: variable?.name ?? "", value: { kind: "formula", expression: event.target.value } }],
          })}
        />
      </>
    );
  }

  if (action.type === "send_notification") {
    return (
      <>
        <input
          aria-label={t("databaseView:recipientIdsForAction", { number })}
          value={action.recipientIds.join(", ")}
          onChange={(event) => onChange({
            ...action,
            recipientIds: event.target.value.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 20),
          })}
        />
        <textarea
          aria-label={t("databaseView:messageForAction", { number })}
          value={action.message}
          onChange={(event) => onChange({ ...action, message: event.target.value })}
        />
      </>
    );
  }

  if (action.type === "send_email") {
    return (
      <>
        <input aria-label={t("databaseView:emailForAction", { number })} value={action.recipientEmail} onChange={(event) => onChange({ ...action, recipientEmail: event.target.value })} />
        <input aria-label={t("databaseView:subjectForAction", { number })} value={action.subject} onChange={(event) => onChange({ ...action, subject: event.target.value })} />
        <textarea aria-label={t("databaseView:messageForAction", { number })} value={action.message} onChange={(event) => onChange({ ...action, message: event.target.value })} />
      </>
    );
  }

  if (action.type === "send_webhook") {
    return (
      <>
        <input aria-label={t("databaseView:urlForAction", { number })} value={action.url} onChange={(event) => onChange({ ...action, url: event.target.value })} />
        <textarea
          aria-label={t("databaseView:webhookBodyForAction", { number })}
          value={JSON.stringify(action.body)}
          onChange={(event) => {
            try {
              onChange({ ...action, body: JSON.parse(event.target.value) as Record<string, unknown> });
            } catch {
              // Keep the last valid JSON body while the user is typing.
            }
          }}
        />
      </>
    );
  }

  if (action.type === "send_slack") {
    return (
      <>
        <input aria-label={t("databaseView:connectionForAction", { number })} value={action.connectionId} onChange={(event) => onChange({ ...action, connectionId: event.target.value })} />
        <input aria-label={t("databaseView:channelForAction", { number })} value={action.channelId} onChange={(event) => onChange({ ...action, channelId: event.target.value })} />
        <textarea aria-label={t("databaseView:messageForAction", { number })} value={action.message} onChange={(event) => onChange({ ...action, message: event.target.value })} />
      </>
    );
  }

  if (action.type === "show_confirmation") {
    return (
      <>
        <input aria-label={t("databaseView:titleForAction", { number })} value={action.title} onChange={(event) => onChange({ ...action, title: event.target.value })} />
        <textarea aria-label={t("databaseView:messageForAction", { number })} value={action.message} onChange={(event) => onChange({ ...action, message: event.target.value })} />
        <input aria-label={t("databaseView:confirmLabelForAction", { number })} value={action.confirmLabel} onChange={(event) => onChange({ ...action, confirmLabel: event.target.value })} />
        <input aria-label={t("databaseView:cancelLabelForAction", { number })} value={action.cancelLabel} onChange={(event) => onChange({ ...action, cancelLabel: event.target.value })} />
      </>
    );
  }

  if (action.type === "open_page") {
    return (
      <select aria-label={t("databaseView:pageForAction", { number })} value={action.pageId} onChange={(event) => onChange({ ...action, pageId: event.target.value })}>
        {pages.filter((page) => !page.inTrash).map((page) => <option key={page.id} value={page.id}>{page.title}</option>)}
      </select>
    );
  }

  if (action.type === "open_form") {
    return (
      <>
        <select aria-label={t("databaseView:targetDatabaseForAction", { number })} value={action.databaseId} onChange={(event) => onChange({ ...action, databaseId: event.target.value })}>
          {databases.map((database) => <option key={database.id} value={database.id}>{database.title}</option>)}
        </select>
        <select aria-label={t("databaseView:formForAction", { number })} value={action.viewId} onChange={(event) => onChange({ ...action, viewId: event.target.value })}>
          {views.map((view) => <option key={view.id} value={view.id}>{view.name || view.id}</option>)}
        </select>
      </>
    );
  }

  return <input aria-label={t("databaseView:urlForAction", { number })} value={action.url} onChange={(event) => onChange({ ...action, url: event.target.value })} />;
}

function PropertyValueField({
  action,
  number,
  properties,
  onChange,
}: {
  action: EditPropertyAutomationAction;
  number: number;
  properties: DbProperty[];
  onChange: (action: AutomationAction) => void;
}) {
  const { t } = useTranslation(["databaseView"]);
  const property = properties.find((candidate) => candidate.id === action.propertyId);
  const literal = action.value.kind === "literal" ? action.value.value : undefined;
  const label = t("databaseView:valueForAction", { number });
  const updateLiteral = (value: unknown) => onChange({ ...action, value: { kind: "literal", value } });

  if (property?.type === "select" || property?.type === "status") {
    return (
      <select aria-label={label} value={typeof literal === "string" ? literal : ""} onChange={(event) => updateLiteral(event.target.value || null)}>
        <option value="">{t("databaseView:clearValue")}</option>
        {(property.config?.options ?? []).map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select>
    );
  }
  if (property?.type === "multi_select") {
    const selected = Array.isArray(literal)
      ? literal.filter((item): item is string => typeof item === "string")
      : [];
    return (
      <select
        multiple
        aria-label={label}
        value={selected}
        onChange={(event) => updateLiteral(
          Array.from(event.currentTarget.selectedOptions, (option) => option.value),
        )}
      >
        {(property.config?.options ?? []).map((option) => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
      </select>
    );
  }
  if (property?.type === "checkbox") {
    return (
      <select aria-label={label} value={literal === true ? "true" : "false"} onChange={(event) => updateLiteral(event.target.value === "true")}>
        <option value="false">{t("databaseView:falseValue")}</option>
        <option value="true">{t("databaseView:trueValue")}</option>
      </select>
    );
  }
  if (property?.type === "number") {
    return <input type="number" aria-label={label} value={typeof literal === "number" ? literal : ""} onChange={(event) => updateLiteral(event.target.value === "" ? null : Number(event.target.value))} />;
  }
  if (property?.type === "date") {
    const mode = action.value.kind === "execution_time"
      ? "execution_time"
      : literal === null
        ? "clear"
        : "literal";
    return (
      <div className={styles.valueRow}>
        <select
          aria-label={t("databaseView:valueModeForAction", { number })}
          value={mode}
          onChange={(event) => {
            if (event.target.value === "execution_time") {
              onChange({ ...action, value: { kind: "execution_time" } });
            } else {
              updateLiteral(event.target.value === "clear" ? null : new Date().toISOString().slice(0, 10));
            }
          }}
        >
          <option value="execution_time">{t("databaseView:executionTime")}</option>
          <option value="literal">{t("databaseView:specificDate")}</option>
          <option value="clear">{t("databaseView:clearValue")}</option>
        </select>
        {mode === "literal" && (
          <input
            type="date"
            aria-label={label}
            value={typeof literal === "string" ? literal.slice(0, 10) : ""}
            onChange={(event) => updateLiteral(event.target.value || null)}
          />
        )}
      </div>
    );
  }
  if (property?.type === "person") {
    const people = Array.isArray(literal)
      ? literal.filter((item): item is string => typeof item === "string")
      : [];
    return (
      <input
        aria-label={label}
        value={people.join(", ")}
        placeholder={t("databaseView:personIdsPlaceholder")}
        onChange={(event) => updateLiteral(
          event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
        )}
      />
    );
  }
  if (property?.type === "verification") {
    const state = literal && typeof literal === "object" && "state" in literal
      ? String((literal as { state?: unknown }).state)
      : "unverified";
    return (
      <select
        aria-label={label}
        value={state === "verified" ? "verified" : "unverified"}
        onChange={(event) => updateLiteral({ state: event.target.value })}
      >
        <option value="unverified">{t("databaseView:unverified")}</option>
        <option value="verified">{t("databaseView:verified")}</option>
      </select>
    );
  }
  if (property?.type === "place") {
    const place = literal && typeof literal === "object" && !Array.isArray(literal)
      ? literal as { lat?: unknown; lon?: unknown }
      : {};
    const updateCoordinate = (key: "lat" | "lon", raw: string) => {
      const parsed = raw === "" ? undefined : Number(raw);
      const lat = key === "lat" ? parsed : typeof place.lat === "number" ? place.lat : undefined;
      const lon = key === "lon" ? parsed : typeof place.lon === "number" ? place.lon : undefined;
      updateLiteral(lat === undefined && lon === undefined
        ? null
        : { ...(lat !== undefined ? { lat } : {}), ...(lon !== undefined ? { lon } : {}) });
    };
    return (
      <div className={styles.valueRow}>
        <input
          type="number"
          step="any"
          aria-label={t("databaseView:latitudeForAction", { number })}
          value={typeof place.lat === "number" ? place.lat : ""}
          onChange={(event) => updateCoordinate("lat", event.target.value)}
        />
        <input
          type="number"
          step="any"
          aria-label={t("databaseView:longitudeForAction", { number })}
          value={typeof place.lon === "number" ? place.lon : ""}
          onChange={(event) => updateCoordinate("lon", event.target.value)}
        />
      </div>
    );
  }
  return <input aria-label={label} value={typeof literal === "string" ? literal : ""} onChange={(event) => updateLiteral(event.target.value)} />;
}

export function automationDocumentActions(value: unknown): AutomationAction[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { actions?: unknown }).actions)) return [];
  return structuredClone((value as { actions: AutomationAction[] }).actions);
}

export function addPageActionTitle(action: AddPageAutomationAction) {
  return typeof action.title === "string" ? action.title : "";
}
