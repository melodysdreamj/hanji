"use client";

import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceFileUrl } from "@/lib/fileUrls";
import { pickLabels } from "@/lib/i18n";
import { pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { DbProperty, FileAttachment, Page } from "@/lib/types";
import { useStore } from "@/lib/store";
import { chipStyle } from "./colors";
import { formatDateForProperty, formatNotionTimestamp } from "./dateUtils";
import { evaluateFormula, formatFormulaValue } from "./formula";
import { isImageAttachment, normalizeFileAttachments } from "./files";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { normalizePersonIds, personLabel } from "./people";
import { evaluateRollup, secondHopDatabaseId, valueAsIds } from "./rollup";
import { CheckIcon, FileText } from "../icons";
import { PageIconGlyph } from "../PageIcon";
import { backendComputedText } from "./computed";
import styles from "./database.module.css";

// Stable empty map so cells that don't resolve related rows (everything except
// relation/rollup/formula) don't re-subscribe to the whole pagesById and
// re-render on every unrelated row edit.
const EMPTY_PAGES: Record<string, Page> = {};

const PROP_VALUE_LABELS = {
  en: {
    relationLoading: "Loading relation items",
    relationUnavailable: "Relation items unavailable",
    unavailable: "Unavailable",
  },
  ko: {
    relationLoading: "관계 항목 불러오는 중",
    relationUnavailable: "관계 항목을 표시할 수 없음",
    unavailable: "사용할 수 없음",
  },
} as const;

/** Read-only display of a row's value for a property (used by list/gallery/board). */
export function PropValue({
  row,
  prop,
  interactive = true,
  onOpenPage,
  pageHrefForRelation,
  presentation = "default",
}: {
  row: Page;
  prop: DbProperty;
  interactive?: boolean;
  onOpenPage?: (pageId: string) => void;
  pageHrefForRelation?: (pageId: string) => string;
  presentation?: "default" | "rowDetail";
}) {
  const needsPages = prop.type === "relation" || prop.type === "rollup" || prop.type === "formula";
  const pagesById = useStore(useShallow((s) => (needsPages ? s.pagesById : EMPTY_PAGES)));
  const hydratedRelationTargetIds = useStore((s) => s.hydratedRelationTargetIds);
  const propsByDb = useStore(useShallow((s) => s.propsByDb));
  const sourceProps = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const relationTargetDbId =
    prop.type === "relation" ? prop.config?.relationDatabaseId ?? prop.databaseId : undefined;
  const relationProp = sourceProps.find(
    (item) => item.id === prop.config?.rollupRelationPropertyId
  );
  const targetDbId = relationProp?.config?.relationDatabaseId ?? relationProp?.databaseId;
  const targetProps = useStore(
    useShallow((s) => (targetDbId ? s.dbProperties(targetDbId) : []))
  );
  const loadDatabase = useStore((s) => s.loadDatabase);
  const userId = useStore((s) => s.userId);
  const v = row.properties?.[prop.id];

  // Database reached by a rollup's optional second hop, so multi-hop rollups can
  // load the next database's properties.
  const secondHopDbId =
    prop.type === "rollup" ? secondHopDatabaseId(prop, targetProps, propsByDb) : undefined;

  useEffect(() => {
    if (relationTargetDbId) void loadDatabase(relationTargetDbId);
    if (prop.type === "rollup" && targetDbId) void loadDatabase(targetDbId);
    if (secondHopDbId) void loadDatabase(secondHopDbId);
  }, [loadDatabase, prop.type, relationTargetDbId, targetDbId, secondHopDbId]);

  if (prop.type === "title") {
    const hasRowIcon = row.iconType !== "none" && !!row.icon;
    return row.title ? (
      <span className={`${styles.cardField} ${styles.titleValue}`}>
        {hasRowIcon && (
          <span className={styles.titleValueIcon} aria-hidden="true">
            <PageIconGlyph page={row} size={16} fallback="none" />
          </span>
        )}
        <span className={styles.titleValueText}>{row.title}</span>
      </span>
    ) : null;
  }

  if (prop.type === "select" || prop.type === "multi_select" || prop.type === "status") {
    const opts = prop.config?.options ?? [];
    const ids = Array.isArray(v) ? v : v ? [v] : [];
    if (ids.length === 0) return null;
    return (
      <>
        {ids.map((id) => {
          const o = opts.find((x) => x.id === String(id));
          return o ? (
            <span key={String(id)} className={styles.chip} style={chipStyle(o.color)}>
              {o.name}
            </span>
          ) : null;
        })}
      </>
    );
  }

  if (prop.type === "checkbox") {
    return (
      <span className={styles.cardField}>
        <span
          className={styles.cardCheckbox}
          data-checked={v ? "true" : undefined}
          aria-label={v ? "Checked" : "Unchecked"}
        >
          {v ? <CheckIcon size={11} aria-hidden="true" /> : null}
        </span>
      </span>
    );
  }
  if (prop.type === "number") {
    const value = formatNumberValue(v, numberFormatForProperty(prop));
    return value ? <span className={styles.cardField}>{value}</span> : null;
  }
  if (prop.type === "relation") {
    const relationIds = valueAsIds(v);
    const pages = relationIds
      .map((id) => pagesById[id])
      .filter((page): page is Page => !!page && !page.inTrash);
    const loadedPageIds = new Set(pages.map((page) => page.id));
    const unresolvedIds = relationIds.filter((id) => !loadedPageIds.has(id));
    const pendingCount = unresolvedIds.filter((id) => !hydratedRelationTargetIds.has(id)).length;
    const missingCount = unresolvedIds.length - pendingCount;
    if (pages.length === 0 && pendingCount === 0 && missingCount === 0) return null;
    const onRelationClick = (pageId: string, e: ReactMouseEvent<HTMLAnchorElement>) => {
      e.stopPropagation();
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      onOpenPage?.(pageId);
    };
    return (
      <>
        <span className={styles.relationChips} data-readonly="true">
          {pages.map((page) => {
            const title = pageDisplayTitle(page);
            const href = pageHrefForRelation?.(page.id) ?? pageHref(page.id);
            return (
              <span key={page.id} className={styles.relationChip} data-row-relation-chip>
                <span className={styles.relationPageIcon} aria-hidden="true">
                  <PageIconGlyph page={page} size={13} />
                </span>
                {interactive && onOpenPage ? (
                  <a
                    className={styles.relationChipLink}
                    href={href}
                    aria-label={`Open ${title}`}
                    onClick={(e) => onRelationClick(page.id, e)}
                    onAuxClick={(e) => e.stopPropagation()}
                  >
                    {title}
                  </a>
                ) : (
                  <span className={styles.relationChipText}>{title}</span>
                )}
              </span>
            );
          })}
          {pendingCount > 0 && (
            <span
              className={styles.relationChipSkeleton}
              data-row-relation-loading
              aria-label={pickLabels(PROP_VALUE_LABELS).relationLoading}
            />
          )}
          {missingCount > 0 && (
            <span
              className={styles.relationMissingChip}
              data-row-relation-missing
              aria-label={pickLabels(PROP_VALUE_LABELS).relationUnavailable}
            >
              {pickLabels(PROP_VALUE_LABELS).unavailable}
            </span>
          )}
        </span>
      </>
    );
  }
  if (prop.type === "files") {
    const files = normalizeFileAttachments(v);
    if (files.length === 0) return null;
    return (
      <span className={styles.filesChips} data-readonly="true">
        {files.map((file) => (
          <ReadonlyFileChip key={file.id} file={file} />
        ))}
      </span>
    );
  }
  if (prop.type === "rollup") {
    const value = backendComputedText(row, prop) ?? evaluateRollup({ row, prop, sourceProps, targetProps, pagesById, propsByDb });
    return value ? <span className={styles.cardField}>{value}</span> : null;
  }
  if (prop.type === "formula") {
    const value = backendComputedText(row, prop) ?? formatFormulaValue(evaluateFormula({ row, prop, props: sourceProps, pagesById }));
    return value ? <span className={styles.cardField}>{value}</span> : null;
  }
  if (prop.type === "date") {
    const text = formatDateForProperty(v, prop);
    return text ? <span className={styles.cardField}>{text}</span> : null;
  }
  if (prop.type === "person") {
    const people = normalizePersonIds(v);
    if (people.length === 0) return null;
    return (
      <>
        {people.map((id) => (
          <span key={id} className={styles.cardField}>
            {personLabel(id, userId)}
          </span>
        ))}
      </>
    );
  }
  if (prop.type === "created_time") {
    return row.createdAt ? (
      <span className={styles.cardField}>{formatNotionTimestamp(row.createdAt)}</span>
    ) : null;
  }
  if (prop.type === "last_edited_time") {
    return row.updatedAt ? (
      <span className={styles.cardField}>{formatNotionTimestamp(row.updatedAt)}</span>
    ) : null;
  }
  if (prop.type === "created_by" || prop.type === "last_edited_by") {
    const people = normalizePersonIds(prop.type === "created_by" ? row.createdBy : row.lastEditedBy);
    if (people.length === 0) return null;
    return <span className={styles.cardField}>{personLabel(people[0], userId)}</span>;
  }
  if (prop.type === "url" || prop.type === "email" || prop.type === "phone") {
    const text = v == null ? "" : String(v).trim();
    if (!text) return null;
    const href =
      prop.type === "email"
        ? `mailto:${text}`
        : prop.type === "phone"
          ? `tel:${text.replace(/\s+/g, "")}`
          : /^https?:\/\//i.test(text)
            ? text
            : `https://${text}`;
    return (
      <a
        className={`${styles.cardField} ${styles.cardLink}`}
        href={href}
        target={prop.type === "url" ? "_blank" : undefined}
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        onAuxClick={(e) => e.stopPropagation()}
      >
        {text}
      </a>
    );
  }

  if (prop.type === "rich_text") {
    const text = v == null ? "" : String(v);
    if (!text) return null;
    const className =
      presentation === "rowDetail"
        ? `${styles.cardField} ${styles.rowPropertyTextValue}`
        : styles.cardField;
    return (
      <span className={className} data-row-property-text={presentation === "rowDetail" ? "true" : undefined}>
        {text}
      </span>
    );
  }

  if (prop.type === "unique_id") {
    if (v == null || v === "") return null;
    const prefix = prop.config?.idPrefix?.trim();
    return <span className={styles.cardField}>{prefix ? `${prefix}-${v}` : String(v)}</span>;
  }

  if (v == null || v === "") return null;
  return <span className={styles.cardField}>{String(v)}</span>;
}

function ReadonlyFileChip({ file }: { file: FileAttachment }) {
  return (
    <span className={styles.fileChip}>
      <ReadonlyFileLink file={file}>
        <ReadonlyFileThumb file={file} />
        <span className={styles.fileName}>{file.name}</span>
      </ReadonlyFileLink>
    </span>
  );
}

function ReadonlyFileLink({
  file,
  children,
}: {
  file: FileAttachment;
  children: ReactNode;
}) {
  const href = useWorkspaceFileUrl(file.url, ["data:"]);

  if (!href) return <span className={styles.fileChipLink}>{children}</span>;

  return (
    <a
      className={styles.fileChipLink}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      download={file.name || undefined}
      aria-label={`Open or download ${file.name}`}
      onClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

function ReadonlyFileThumb({ file }: { file: FileAttachment }) {
  const isImage = isImageAttachment(file);
  const url = useWorkspaceFileUrl(file.url, ["data:image/"]);
  const style = isImage && url ? { backgroundImage: `url("${url.replace(/"/g, '\\"')}")` } : undefined;

  return (
    <span className={styles.fileThumb} data-image={isImage ? "true" : undefined} style={style}>
      {!isImage && <FileText size={13} aria-hidden="true" />}
    </span>
  );
}
