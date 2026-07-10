"use client";

import {
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { searchOrganizationPeopleRemote } from "@/lib/edgebase";
import { storageKeyFromUrl, useWorkspaceFileUrl } from "@/lib/fileUrls";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type {
  DbProperty,
  FileAttachment,
  OrganizationProfile,
  Page,
  SelectOption,
} from "@/lib/types";
import { useStore } from "@/lib/store";
import { newId } from "@/lib/ids";
import {
  createWorkspaceFileDownloadUrl,
  deleteWorkspaceFile,
  uploadWorkspaceFile,
} from "@/lib/storage";
import type { UploadProgress } from "@/lib/storage";
import { safeStoredFileUrl } from "@/lib/urls";
import { chipStyle, COLOR_NAMES, type ColorName, nextColor } from "./colors";
import {
  addDays,
  addMonths,
  dateKey,
  extractEnd,
  extractTime,
  formatDateForProperty,
  formatDateInput,
  formatNotionTimestamp,
  formatTime12,
  monthCells,
  monthLabel,
  parseDate,
  parseDateDraft,
  parseTimeDraft,
  startOfMonth,
} from "./dateUtils";
import { evaluateFormula, formatFormulaValue } from "./formula";
import {
  fileNameFromUrl,
  formatFileSize,
  isImageAttachment,
  normalizeFileAttachments,
} from "./files";
import { formatNumberValue, numberFormatForProperty } from "./numberFormat";
import { normalizePersonIds, personInitials, personLabel } from "./people";
import { evaluateRollup, secondHopDatabaseId, valueAsIds } from "./rollup";
import { useRouter } from "@/lib/router";
import {
  CheckIcon,
  DotsHorizontal,
  Download,
  DragHandleIcon,
  FileText,
  OpenInNew,
  Plus,
  Trash,
  X,
} from "../icons";
import { PageIconGlyph } from "../PageIcon";
import { backendComputedText } from "./computed";
import styles from "./database.module.css";

const SELECT_OPTION_DRAG = "application/x-notionlike-select-option";

const PROPERTY_CELL_LABELS = {
  en: {
    add: "Add",
    addFileOrImage: "Add file or image",
    clear: "Clear",
    closeMenu: "Close menu",
    closeOptionEditor: "Close option editor",
    create: "Create",
    date: "Date",
    delete: "Delete",
    deleteOption: "Delete option",
    deleteOptionFailed: "Couldn't delete option",
    deletedOption: "Deleted option",
    download: "Download",
    downloadAll: "Download all",
    downloadFile: (name: string) => `Download ${name}`,
    dragOption: (name: string) => `Drag ${name} option`,
    edit: (name: string) => `Edit ${name}`,
    editDate: "Edit date",
    editDateProperty: "Edit date property",
    editDateValue: (value: string) => `Edit date, ${value}`,
    editFiles: (name: string) => `Edit ${name} files`,
    editFilesProperty: "Edit files property",
    editMultiSelect: (name: string) => `Edit ${name} multi-select`,
    editMultiSelectProperty: "Edit multi-select property",
    editOption: "Edit option",
    editPeople: (name: string) => `Edit ${name} people`,
    editPersonProperty: "Edit person property",
    editRelation: (name: string) => `Edit ${name} relation`,
    editRelationProperty: "Edit relation property",
    editSelect: (name: string) => `Edit ${name} select`,
    editSelectProperty: "Edit select property",
    endDate: "End date",
    fileActions: (name: string) => `${name} file actions`,
    fileMenu: (name: string) => `${name} file menu`,
    fileStoredDeleteFailed: "Couldn't delete the stored file.",
    fileUploadFailed: "Couldn't upload the selected file.",
    includeTime: "Include time",
    newRelation: (title: string) => `New "${title}"`,
    nextMonth: "Next month",
    noAttachments: "No attachments",
    noDownloadUrl: "No downloadable file URL.",
    noMatchingPages: "No matching pages",
    noOpenUrl: "No openable file URL.",
    noOptionsYet: "No options yet",
    noPagesYet: "No pages yet",
    noPeopleFound: "No people found",
    open: (name: string) => `Open ${name}`,
    optionName: "Option name",
    options: "Options",
    orgPersonFallback: "Organization person",
    pasteFileUrl: "Paste a file or image URL",
    pasteHttpFileLink: "Paste an http or https file link.",
    person: "Person",
    prevMonth: "Previous month",
    relationDatabaseUnavailable: "Relation database is unavailable",
    relationLoading: "Loading relation items",
    relationUnavailable: "Relation items unavailable",
    relatedPages: "Related pages",
    remove: (name: string) => `Remove ${name}`,
    rename: "Rename",
    restoreOptionFailed: "Couldn't restore option",
    restoredOption: "Restored option",
    roleInOrganization: (role: string) => `${role} in organization`,
    searchOptionsAria: "Search options",
    searchOrCreate: "Search or create…",
    searchOrganizationPeople: "Search organization people",
    searchPages: (title: string) => `Search ${title}...`,
    searchPagesFallback: "Search pages...",
    searchPeople: "Search people",
    searchRelatedPages: "Search related pages",
    selectPeople: "Select people",
    time: "Time",
    today: "Today",
    tomorrow: "Tomorrow",
    unavailable: "Unavailable",
    undo: "Undo",
    uploadComplete: "Upload complete",
    uploadFinishing: "Finishing upload",
    uploadFromDevice: "Upload from device",
    uploadPreparing: "Preparing upload",
    uploading: "Uploading...",
    uploadingFile: (name: string) => `Uploading ${name}`,
    uploadingProgress: "Uploading",
    viewOriginal: "View original",
    weekdays: ["S", "M", "T", "W", "T", "F", "S"],
    you: "You",
  },
  ko: {
    add: "추가",
    addFileOrImage: "파일 또는 이미지 추가",
    clear: "지우기",
    closeMenu: "메뉴 닫기",
    closeOptionEditor: "옵션 편집기 닫기",
    create: "생성",
    date: "날짜",
    delete: "삭제",
    deleteOption: "옵션 삭제",
    deleteOptionFailed: "옵션을 삭제하지 못했어요",
    deletedOption: "옵션을 삭제했어요",
    download: "다운로드",
    downloadAll: "모두 다운로드",
    downloadFile: (name: string) => `${name} 다운로드`,
    dragOption: (name: string) => `${name} 옵션 드래그`,
    edit: (name: string) => `${name} 편집`,
    editDate: "날짜 편집",
    editDateProperty: "날짜 속성 편집",
    editDateValue: (value: string) => `날짜 편집, ${value}`,
    editFiles: (name: string) => `${name} 파일 편집`,
    editFilesProperty: "파일 속성 편집",
    editMultiSelect: (name: string) => `${name} 다중 선택 편집`,
    editMultiSelectProperty: "다중 선택 속성 편집",
    editOption: "옵션 편집",
    editPeople: (name: string) => `${name} 사람 편집`,
    editPersonProperty: "사람 속성 편집",
    editRelation: (name: string) => `${name} 관계형 편집`,
    editRelationProperty: "관계형 속성 편집",
    editSelect: (name: string) => `${name} 선택 편집`,
    editSelectProperty: "선택 속성 편집",
    endDate: "종료일",
    fileActions: (name: string) => `${name} 파일 작업`,
    fileMenu: (name: string) => `${name} 파일 메뉴`,
    fileStoredDeleteFailed: "저장된 파일을 삭제하지 못했어요.",
    fileUploadFailed: "선택한 파일을 업로드하지 못했어요.",
    includeTime: "시간 포함",
    newRelation: (title: string) => `"${title}" 새로 만들기`,
    nextMonth: "다음 달",
    noAttachments: "첨부파일 없음",
    noDownloadUrl: "다운로드할 수 있는 파일 URL이 없어요.",
    noMatchingPages: "일치하는 페이지가 없습니다",
    noOpenUrl: "열 수 있는 파일 URL이 없어요.",
    noOptionsYet: "아직 옵션이 없습니다",
    noPagesYet: "아직 페이지가 없습니다",
    noPeopleFound: "일치하는 사람이 없습니다",
    open: (name: string) => `${name} 열기`,
    optionName: "옵션 이름",
    options: "옵션",
    orgPersonFallback: "조직 구성원",
    pasteFileUrl: "파일 또는 이미지 URL 붙여넣기",
    pasteHttpFileLink: "http 또는 https 파일 링크를 붙여넣으세요.",
    person: "사람",
    prevMonth: "이전 달",
    relationDatabaseUnavailable: "관계형 데이터베이스를 사용할 수 없습니다",
    relationLoading: "관계 항목 불러오는 중",
    relationUnavailable: "관계 항목을 표시할 수 없음",
    relatedPages: "관련 페이지",
    remove: (name: string) => `${name} 제거`,
    rename: "이름 바꾸기",
    restoreOptionFailed: "옵션을 복원하지 못했어요",
    restoredOption: "옵션을 복원했어요",
    roleInOrganization: (role: string) => `조직 내 ${role}`,
    searchOptionsAria: "옵션 검색",
    searchOrCreate: "검색 또는 생성…",
    searchOrganizationPeople: "조직 구성원 검색",
    searchPages: (title: string) => `${title} 검색...`,
    searchPagesFallback: "페이지 검색...",
    searchPeople: "사람 검색",
    searchRelatedPages: "관련 페이지 검색",
    selectPeople: "사람 선택",
    time: "시간",
    today: "오늘",
    tomorrow: "내일",
    unavailable: "사용할 수 없음",
    undo: "되돌리기",
    uploadComplete: "업로드 완료",
    uploadFinishing: "업로드 마무리 중",
    uploadFromDevice: "기기에서 업로드",
    uploadPreparing: "업로드 준비 중",
    uploading: "업로드 중...",
    uploadingFile: (name: string) => `${name} 업로드 중`,
    uploadingProgress: "업로드 중",
    viewOriginal: "원본 보기",
    weekdays: ["일", "월", "화", "수", "목", "금", "토"],
    you: "나",
  },
} as const;

function propertyCellLabels() {
  return pickLabels(PROPERTY_CELL_LABELS);
}

function getValue(row: Page, prop: DbProperty): unknown {
  if (prop.type === "title") return row.title;
  if (prop.type === "created_time") return row.createdAt;
  if (prop.type === "last_edited_time") return row.updatedAt;
  if (prop.type === "created_by") return row.createdBy;
  if (prop.type === "last_edited_by") return row.lastEditedBy;
  return row.properties?.[prop.id];
}

/**
 * Renders a cell editor popover in a portal, positioned next to its trigger and
 * flipped above when there isn't room below — so it's never clipped by the
 * table's overflow:auto scroll container.
 */
function CellMenuPortal<T extends HTMLElement>({
  triggerRef,
  onClose,
  ariaLabel,
  className,
  width = 240,
  scroll = true,
  onKeyDown,
  children,
}: {
  triggerRef: RefObject<T | null>;
  onClose: () => void;
  ariaLabel: string;
  className: string;
  width?: number;
  scroll?: boolean;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  const [pos, setPos] = useState<
    { left: number; top?: number; bottom?: number; maxHeight: number } | null
  >(null);

  useLayoutEffect(() => {
    function place() {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const M = 8;
      const left = Math.min(Math.max(M, r.left), window.innerWidth - width - M);
      const below = window.innerHeight - r.bottom - M;
      const above = r.top - M;
      if (below >= 220 || below >= above) {
        setPos({ left, top: r.bottom + 2, maxHeight: Math.max(160, below) });
      } else {
        setPos({ left, bottom: window.innerHeight - r.top + 2, maxHeight: Math.max(160, above) });
      }
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [triggerRef, width]);

  if (!pos) return null;
  return createPortal(
    <>
      <button
        type="button"
        className={styles.menuBackdrop}
        style={{ zIndex: 1000 }}
        tabIndex={-1}
        aria-label={propertyCellLabels().closeMenu}
        onClick={onClose}
      />
      <div
        className={className}
        style={{
          position: "fixed",
          zIndex: 1001,
          left: pos.left,
          top: pos.top,
          bottom: pos.bottom,
          width,
          ...(scroll ? { maxHeight: pos.maxHeight, overflowY: "auto" as const } : {}),
        }}
        role="dialog"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

function PropertyCellImpl({
  row,
  prop,
  autoFocus,
  onOpenPage,
  presentation = "default",
}: {
  row: Page;
  prop: DbProperty;
  autoFocus?: boolean;
  onOpenPage?: (pageId: string) => void;
  presentation?: "default" | "rowDetail";
}) {
  const updatePage = useStore((s) => s.updatePage);
  const setRowProperty = useStore((s) => s.setRowProperty);

  const setValue = (v: unknown) => {
    if (prop.type === "title") updatePage(row.id, { title: String(v ?? "") });
    else setRowProperty(row.id, prop.id, v, { debounce: false });
  };

  const value = getValue(row, prop);

  switch (prop.type) {
    case "checkbox":
      return (
        <span className={styles.cellCheck}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => setValue(e.target.checked)}
          />
        </span>
      );
    case "number":
      return (
        <NumberCell
          key={value == null ? "" : String(value)}
          prop={prop}
          value={value}
          autoFocus={autoFocus}
          onCommit={setValue}
        />
      );
    case "select":
    case "status":
      return <SelectCell row={row} prop={prop} multi={false} />;
    case "multi_select":
      return <SelectCell row={row} prop={prop} multi={true} />;
    case "files":
      return <FilesCell row={row} prop={prop} />;
    case "relation":
      return <RelationCell row={row} prop={prop} onOpenPage={onOpenPage} />;
    case "rollup":
      return <RollupCell row={row} prop={prop} />;
    case "formula":
      return <FormulaCell row={row} prop={prop} />;
    case "date":
      return (
        <DateCell
          prop={prop}
          value={value}
          autoFocus={autoFocus}
          onCommit={(next) => setValue(next)}
        />
      );
    case "person":
      return <PersonCell row={row} prop={prop} />;
    case "created_by":
    case "last_edited_by":
      return <PeopleReadonly value={value} />;
    case "created_time":
    case "last_edited_time":
      return (
        <span className={styles.cellReadonly}>
          {formatNotionTimestamp(value)}
        </span>
      );
    case "unique_id": {
      const prefix = prop.config?.idPrefix?.trim();
      return (
        <span className={styles.cellReadonly}>
          {value != null && value !== "" ? `${prefix ? `${prefix}-` : ""}${value}` : ""}
        </span>
      );
    }
    default:
      // title, rich_text, url, email, phone → text input
      return (
        <TextCell
          row={row}
          prop={prop}
          value={value}
          autoFocus={autoFocus}
          onCommit={setValue}
          presentation={presentation}
        />
      );
  }
}

function linkHref(type: DbProperty["type"], value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (type === "email") return `mailto:${v}`;
  if (type === "phone") return `tel:${v.replace(/\s+/g, "")}`;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
}

function databaseTitleCellText(row: Page, value: unknown) {
  const text = value == null ? "" : String(value);
  // Legacy imported/created database rows sometimes persisted Notion's empty
  // title fallback as real text. In a database cell, keep that Notion-like blank.
  if (row.parentType === "database" && text.trim() === "Untitled") return "";
  return text;
}

function TextCell({
  row,
  prop,
  value,
  autoFocus,
  onCommit,
  presentation = "default",
}: {
  row: Page;
  prop: DbProperty;
  value: unknown;
  autoFocus?: boolean;
  onCommit: (v: string) => void;
  presentation?: "default" | "rowDetail";
}) {
  const initial = prop.type === "title" ? databaseTitleCellText(row, value) : value == null ? "" : String(value);
  const [text, setText] = useState(initial);
  const [editing, setEditing] = useState(!!autoFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isLink = prop.type === "url" || prop.type === "email" || prop.type === "phone";
  const isRowDetailText = presentation === "rowDetail" && prop.type === "rich_text";
  const hasRowIcon = row.iconType !== "none" && !!row.icon;

  const dirtyRef = useRef(false);
  // Reflect external changes (a collaborator edit or an undo) to the cell value
  // while the user hasn't typed, so a later blur can't clobber the newer value
  // with this cell's stale snapshot.
  useEffect(() => {
    if (dirtyRef.current) return;
    setText(initial);
  }, [initial]);
  function handleInput(next: string) {
    dirtyRef.current = true;
    setText(next);
  }

  useEffect(() => {
    if (!editing && !autoFocus) return;
    requestAnimationFrame(() => {
      if (isRowDetailText) textareaRef.current?.focus();
      else inputRef.current?.focus();
    });
  }, [autoFocus, editing, isRowDetailText]);

  useLayoutEffect(() => {
    if (!isRowDetailText) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(31, el.scrollHeight)}px`;
  }, [isRowDetailText, text]);

  function commit() {
    if (dirtyRef.current && text !== initial) onCommit(text);
    dirtyRef.current = false;
    setEditing(false);
  }

  if (isLink && !editing) {
    const href = linkHref(prop.type, initial);
    return (
      <div className={styles.linkCell}>
        <button
          type="button"
          className={styles.numberDisplay}
          aria-label={propertyCellLabels().edit(prop.name)}
          onClick={() => {
            setText(initial);
            setEditing(true);
          }}
        >
          {initial ? (
            <span className={styles.linkText}>{initial}</span>
          ) : (
            <span className={styles.cellEmpty}>&nbsp;</span>
          )}
        </button>
        {href && (
          <a
            className={styles.linkOpen}
            href={href}
            target={prop.type === "url" ? "_blank" : undefined}
            rel="noreferrer noopener"
            aria-label={propertyCellLabels().open(initial)}
            onClick={(e) => e.stopPropagation()}
          >
            <OpenInNew size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    );
  }

  if (prop.type === "title") {
    return (
      <span className={styles.titleCell}>
        {hasRowIcon && (
          <span className={styles.titleCellIcon} aria-hidden="true">
            <PageIconGlyph page={row} size={18} fallback="none" />
          </span>
        )}
        <input
          ref={inputRef}
          className={styles.cellInput}
          data-table-title-input
          type="text"
          autoFocus={autoFocus}
          placeholder=""
          value={text}
          onChange={(e) => handleInput(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (isComposingKeyEvent(e)) return;
            if (e.key === "Enter") {
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setText(initial);
              setEditing(false);
            }
          }}
        />
      </span>
    );
  }

  if (isRowDetailText) {
    return (
      <textarea
        ref={textareaRef}
        className={`${styles.cellInput} ${styles.rowTextCell}`}
        data-row-property-text="true"
        autoFocus={autoFocus}
        placeholder=""
        value={text}
        onChange={(e) => handleInput(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (isComposingKeyEvent(e)) return;
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            (e.target as HTMLTextAreaElement).blur();
          } else if (e.key === "Escape") {
            setText(initial);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <input
      ref={inputRef}
      className={styles.cellInput}
      type="text"
      autoFocus={autoFocus}
      placeholder=""
      value={text}
      onChange={(e) => handleInput(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isComposingKeyEvent(e)) return;
        if (e.key === "Enter") {
          (e.target as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          setText(initial);
          setEditing(false);
        }
      }}
    />
  );
}

function PersonBadge({
  id,
  currentUserId,
  onRemove,
}: {
  id: string;
  currentUserId?: string;
  onRemove?: () => void;
}) {
  const label = personLabel(id, currentUserId);
  if (!label) return null;
  return (
    <span className={styles.personChip}>
      <span className={styles.personAvatar}>{personInitials(id, currentUserId)}</span>
      <span>{label}</span>
      {onRemove && (
        <button
          type="button"
          aria-label={propertyCellLabels().remove(label)}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={10} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

function PeopleReadonly({ value }: { value: unknown }) {
  const userId = useStore((s) => s.userId);
  const ids = normalizePersonIds(value);
  return (
    <span className={styles.peopleReadonly}>
      {ids.map((id) => (
        <PersonBadge key={id} id={id} currentUserId={userId} />
      ))}
      {ids.length === 0 && <span className={styles.cellEmpty}>&nbsp;</span>}
    </span>
  );
}

function organizationProfilePersonLabel(profile: OrganizationProfile) {
  return (
    profile.displayName?.trim() ||
    profile.email?.trim() ||
    profile.userId?.trim() ||
    propertyCellLabels().person
  );
}

function organizationProfilePersonDescription(profile: OrganizationProfile) {
  const parts = [
    profile.email?.trim(),
    profile.organizationRole
      ? propertyCellLabels().roleInOrganization(profile.organizationRole)
      : null,
    profile.status && profile.status !== "active" ? profile.status : null,
  ].filter(Boolean);
  return parts.join(" - ") || propertyCellLabels().orgPersonFallback;
}

function personOptionMatches(label: string, description: string, userId: string, query: string) {
  if (!query) return true;
  const haystack = `${label} ${description} ${userId}`.toLowerCase();
  return query.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

function PersonCell({ row, prop }: { row: Page; prop: DbProperty }) {
  const userId = useStore((s) => s.userId);
  const organization = useStore((s) => s.organization);
  const organizationProfiles = useStore((s) => s.organizationProfiles);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchedPeople, setSearchedPeople] = useState<{
    key: string;
    people: OrganizationProfile[];
  }>({ key: "", people: [] });
  const triggerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRef = useRef<HTMLButtonElement>(null);
  const currentId = userId || "local-user";
  const ids = normalizePersonIds(row.properties?.[prop.id]);
  const selected = new Set(ids);
  const searchKey = query.trim().toLowerCase();

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus() ?? optionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !organization?.id || !searchKey) {
      setSearchedPeople({ key: "", people: [] });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchOrganizationPeopleRemote({
        organizationId: organization.id,
        query: searchKey,
        limit: 12,
      })
        .then((result) => {
          if (!cancelled) setSearchedPeople({ key: searchKey, people: result.people ?? [] });
        })
        .catch(() => {
          if (!cancelled) setSearchedPeople({ key: searchKey, people: [] });
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, organization?.id, searchKey]);

  const peopleOptions = useMemo(() => {
    const options = new Map<string, { id: string; label: string; description: string }>();
    const addOption = (id: string | undefined | null, label: string, description: string) => {
      const normalizedId = id?.trim();
      if (!normalizedId || options.has(normalizedId)) return;
      if (!personOptionMatches(label, description, normalizedId, searchKey)) return;
      options.set(normalizedId, { id: normalizedId, label, description });
    };
    addOption(currentId, personLabel(currentId, userId), propertyCellLabels().you);
    const searchPeople = searchedPeople.key === searchKey ? searchedPeople.people : [];
    for (const profile of [...searchPeople, ...organizationProfiles]) {
      addOption(
        profile.userId,
        organizationProfilePersonLabel(profile),
        organizationProfilePersonDescription(profile)
      );
    }
    return Array.from(options.values()).slice(0, 12);
  }, [currentId, organizationProfiles, searchKey, searchedPeople, userId]);

  function commit(next: string[]) {
    setRowProperty(row.id, prop.id, next.length ? next : null, { debounce: false });
  }

  function togglePerson(personId: string) {
    commit(
      selected.has(personId)
        ? ids.filter((id) => id !== personId)
        : [...ids, personId]
    );
  }

  function openMenu() {
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMenu();
  }

  return (
    <div className={styles.peopleCell}>
      <div
        ref={triggerRef}
        className={styles.personChips}
        role="button"
        tabIndex={0}
        aria-label={propertyCellLabels().editPeople(prop.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
        onKeyDown={onTriggerKeyDown}
      >
        {ids.map((id) => (
          <PersonBadge
            key={id}
            id={id}
            currentUserId={userId}
            onRemove={() => commit(ids.filter((item) => item !== id))}
          />
        ))}
        {ids.length === 0 && <span className={styles.cellEmpty}>&nbsp;</span>}
      </div>
      {open && (
        <CellMenuPortal
          triggerRef={triggerRef}
          onClose={() => closeMenu(true)}
          ariaLabel={propertyCellLabels().editPersonProperty}
          className={styles.peopleMenu}
          width={260}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            closeMenu(true);
          }}
        >
          <div className={styles.propMenuLabel}>{propertyCellLabels().selectPeople}</div>
          <input
            ref={searchRef}
            className={styles.peopleSearch}
            type="search"
            value={query}
            placeholder={propertyCellLabels().searchPeople}
            aria-label={propertyCellLabels().searchOrganizationPeople}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className={styles.peopleList} role="listbox" aria-multiselectable="true">
            {peopleOptions.length === 0 ? (
              <div className={styles.peopleEmpty} role="status">
                {propertyCellLabels().noPeopleFound}
              </div>
            ) : (
              peopleOptions.map((person, index) => (
                <button
                  ref={index === 0 ? optionRef : undefined}
                  key={person.id}
                  type="button"
                  className={styles.peopleOption}
                  role="option"
                  aria-selected={selected.has(person.id)}
                  data-selected={selected.has(person.id) ? "true" : undefined}
                  onClick={() => togglePerson(person.id)}
                >
                  <span className={styles.personAvatar}>{personInitials(person.id, userId)}</span>
                  <span className={styles.peopleOptionText}>
                    <span>{person.label}</span>
                    <span>{person.description}</span>
                  </span>
                  {selected.has(person.id) && (
                    <span className={styles.check}>
                      <CheckIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </button>
              ))
            )}
          </div>
        </CellMenuPortal>
      )}
    </div>
  );
}

function DateCell({
  prop,
  value,
  autoFocus,
  onCommit,
}: {
  prop: DbProperty;
  value: unknown;
  autoFocus?: boolean;
  onCommit: (value: string | null) => void;
}) {
  const selected = parseDate(value);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(selected ?? new Date()));
  const [focusKey, setFocusKey] = useState(() => dateKey(selected ?? new Date()));
  const [includeTime, setIncludeTime] = useState(() => !!extractTime(value));
  const [time, setTime] = useState(() => extractTime(value) || "09:00");
  const [dateDraft, setDateDraft] = useState(() => formatDateInput(selected));
  const [timeDraft, setTimeDraft] = useState(() => formatTime12(extractTime(value) || "09:00"));
  const [includeEnd, setIncludeEnd] = useState(() => !!extractEnd(value));
  const [endKey, setEndKey] = useState(
    () => extractEnd(value).slice(0, 10) || dateKey(parseDate(value) ?? new Date())
  );
  const [endDraft, setEndDraft] = useState(() =>
    formatDateInput(parseDate(extractEnd(value)) ?? parseDate(value) ?? new Date())
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const displayDate = formatDateForProperty(value, prop);
  const gridRef = useRef<HTMLDivElement>(null);

  // Build the stored value from a start date plus the time/range options. Explicit
  // overrides avoid reading not-yet-committed state when a toggle changes.
  function buildValue(
    startDate: Date,
    o: { includeTime?: boolean; time?: string; includeEnd?: boolean; endKey?: string } = {}
  ) {
    const withT = o.includeTime ?? includeTime;
    const t = o.time ?? time;
    const withE = o.includeEnd ?? includeEnd;
    const eKey = o.endKey ?? endKey;
    let start = dateKey(startDate);
    if (withT) start += `T${t}`;
    if (!withE) return start;
    let end = eKey;
    if (withT) end += `T${t}`;
    return `${start}/${end}`;
  }
  const cells = useMemo(() => monthCells(month), [month]);
  const selectedKey = selected ? dateKey(selected) : "";
  const todayKey = dateKey(new Date());

  function openMenu() {
    const next = selected ?? new Date();
    setMonth(startOfMonth(next));
    setFocusKey(dateKey(next));
    setDateDraft(formatDateInput(selected));
    setEndDraft(formatDateInput(parseDate(endKey) ?? next));
    setTimeDraft(formatTime12(time));
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function commitDate(date: Date | null, close = true) {
    onCommit(date ? buildValue(date) : null);
    if (date) {
      setMonth(startOfMonth(date));
      setFocusKey(dateKey(date));
      setDateDraft(formatDateInput(date));
    } else {
      setDateDraft("");
    }
    if (close) closeMenu(true);
  }

  function commitDateDraft(raw = dateDraft) {
    if (!raw.trim()) {
      commitDate(null, false);
      return;
    }
    const date = parseDateDraft(raw, selected?.getFullYear() ?? month.getFullYear());
    if (!date) {
      setDateDraft(formatDateInput(selected));
      return;
    }
    commitDate(date, false);
  }

  function setTimeEnabled(enabled: boolean) {
    setIncludeTime(enabled);
    if (enabled) setTimeDraft(formatTime12(time));
    if (selected) onCommit(buildValue(selected, { includeTime: enabled }));
  }

  function commitTimeDraft(raw = timeDraft) {
    const next = parseTimeDraft(raw);
    if (!next) {
      setTimeDraft(formatTime12(time));
      return;
    }
    setIncludeTime(true);
    setTime(next);
    setTimeDraft(formatTime12(next));
    if (selected) onCommit(buildValue(selected, { includeTime: true, time: next }));
  }

  function setEndEnabled(enabled: boolean) {
    setIncludeEnd(enabled);
    if (enabled) setEndDraft(formatDateInput(parseDate(endKey) ?? selected ?? new Date()));
    if (selected) onCommit(buildValue(selected, { includeEnd: enabled }));
  }

  function commitEndDraft(raw = endDraft) {
    if (!raw.trim()) {
      setIncludeEnd(false);
      setEndDraft(formatDateInput(parseDate(endKey) ?? selected ?? new Date()));
      if (selected) onCommit(buildValue(selected, { includeEnd: false }));
      return;
    }
    const date = parseDateDraft(raw, selected?.getFullYear() ?? month.getFullYear());
    if (!date) {
      setEndDraft(formatDateInput(parseDate(endKey)));
      return;
    }
    const next = dateKey(date);
    setIncludeEnd(true);
    setEndKey(next);
    setEndDraft(formatDateInput(date));
    if (selected) onCommit(buildValue(selected, { endKey: next, includeEnd: true }));
  }

  function focusDate(date: Date) {
    const key = dateKey(date);
    setMonth(startOfMonth(date));
    setFocusKey(key);
    window.requestAnimationFrame(() => {
      gridRef.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${key}"]`)
        ?.focus();
    });
  }

  function shiftMonth(months: number) {
    focusDate(addMonths(parseDate(focusKey) ?? selected ?? month, months));
  }

  function onGridKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const current = parseDate(focusKey) ?? selected ?? new Date();
    let next: Date | null = null;

    if (e.key === "ArrowLeft") next = addDays(current, -1);
    else if (e.key === "ArrowRight") next = addDays(current, 1);
    else if (e.key === "ArrowUp") next = addDays(current, -7);
    else if (e.key === "ArrowDown") next = addDays(current, 7);
    else if (e.key === "Home") next = addDays(current, -current.getDay());
    else if (e.key === "End") next = addDays(current, 6 - current.getDay());
    else if (e.key === "PageUp") next = addMonths(current, e.shiftKey ? -12 : -1);
    else if (e.key === "PageDown") next = addMonths(current, e.shiftKey ? 12 : 1);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      commitDate(current);
      return;
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
      return;
    }

    if (!next) return;
    e.preventDefault();
    focusDate(next);
  }

  return (
    <div className={styles.dateCell}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.dateButton}
        autoFocus={autoFocus}
        aria-label={
          selected
            ? propertyCellLabels().editDateValue(displayDate)
            : propertyCellLabels().editDate
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
      >
        {selected ? (
          <span className={styles.dateValue}>{displayDate}</span>
        ) : (
          <span className={styles.cellEmpty}>&nbsp;</span>
        )}
      </button>
      {open && (
        <CellMenuPortal
          triggerRef={triggerRef}
          onClose={() => closeMenu(true)}
          ariaLabel={propertyCellLabels().editDateProperty}
          className={styles.dateMenu}
          width={260}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenu(true);
            }
          }}
        >
            <input
              className={styles.dateInput}
              type="text"
              autoFocus
              placeholder={propertyCellLabels().date}
              value={dateDraft}
              onChange={(e) => setDateDraft(e.target.value)}
              onBlur={() => commitDateDraft()}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitDateDraft();
                } else if (e.key === "ArrowDown" && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  commitDateDraft();
                  focusDate(parseDate(focusKey) ?? selected ?? new Date());
                } else if (e.key === "Escape") {
                  setDateDraft(formatDateInput(selected));
                }
              }}
            />
            <div className={styles.dateQuickRow}>
              <button type="button" onClick={() => commitDate(new Date())}>
                {propertyCellLabels().today}
              </button>
              <button type="button" onClick={() => commitDate(addDays(new Date(), 1))}>
                {propertyCellLabels().tomorrow}
              </button>
              <button type="button" onClick={() => commitDate(null)}>
                {propertyCellLabels().clear}
              </button>
            </div>
            <div className={styles.dateOptionRow}>
              <label className={styles.dateTimeToggle}>
                <input
                  type="checkbox"
                  checked={includeTime}
                  onChange={(e) => setTimeEnabled(e.target.checked)}
                />
                <span>{propertyCellLabels().includeTime}</span>
              </label>
              {includeTime && (
                <input
                  className={styles.dateTimeInput}
                  type="text"
                  value={timeDraft}
                  aria-label={propertyCellLabels().time}
                  placeholder={propertyCellLabels().time}
                  onChange={(e) => setTimeDraft(e.target.value)}
                  onBlur={() => commitTimeDraft()}
                  onKeyDown={(e) => {
                    if (isComposingKeyEvent(e)) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitTimeDraft();
                    } else if (e.key === "Escape") {
                      setTimeDraft(formatTime12(time));
                    }
                  }}
                />
              )}
            </div>
            <div className={styles.dateOptionRow}>
              <label className={styles.dateTimeToggle}>
                <input
                  type="checkbox"
                  checked={includeEnd}
                  onChange={(e) => setEndEnabled(e.target.checked)}
                />
                <span>{propertyCellLabels().endDate}</span>
              </label>
              {includeEnd && (
                <input
                  className={styles.dateTimeInput}
                  type="text"
                  value={endDraft}
                  aria-label={propertyCellLabels().endDate}
                  placeholder={propertyCellLabels().endDate}
                  onChange={(e) => setEndDraft(e.target.value)}
                  onBlur={() => commitEndDraft()}
                  onKeyDown={(e) => {
                    if (isComposingKeyEvent(e)) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitEndDraft();
                    } else if (e.key === "Escape") {
                      setEndDraft(formatDateInput(parseDate(endKey)));
                    }
                  }}
                />
              )}
            </div>
            <div className={styles.dateCalendarHead}>
              <button
                type="button"
                aria-label={propertyCellLabels().prevMonth}
                onClick={() => shiftMonth(-1)}
              >
                {"<"}
              </button>
              <span>{monthLabel(month)}</span>
              <button
                type="button"
                aria-label={propertyCellLabels().nextMonth}
                onClick={() => shiftMonth(1)}
              >
                {">"}
              </button>
            </div>
            <div className={styles.dateWeekdays}>
              {propertyCellLabels().weekdays.map((day, index) => (
                <span key={`${day}-${index}`}>{day}</span>
              ))}
            </div>
            <div
              className={styles.dateGrid}
              ref={gridRef}
              role="grid"
              tabIndex={-1}
              aria-label={monthLabel(month)}
              onKeyDown={onGridKeyDown}
            >
              {cells.map((day) => {
                const key = dateKey(day);
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    aria-selected={key === selectedKey}
                    aria-label={day.toLocaleDateString(activeDateLocale(), {
                      weekday: "long",
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                    tabIndex={key === focusKey ? 0 : -1}
                    data-date={key}
                    data-focused={key === focusKey ? "true" : undefined}
                    data-outside={day.getMonth() !== month.getMonth() ? "true" : undefined}
                    data-selected={key === selectedKey ? "true" : undefined}
                    data-today={key === todayKey ? "true" : undefined}
                    onClick={() => commitDate(day)}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
        </CellMenuPortal>
      )}
    </div>
  );
}

async function uploadFileAttachment(
  file: File,
  row: Page,
  prop: DbProperty,
  onProgress?: (progress: UploadProgress) => void
): Promise<FileAttachment> {
  const uploaded = await uploadWorkspaceFile(file, "database/files", {
    pageId: row.id,
    databaseId: prop.databaseId,
    propertyId: prop.id,
  }, { onProgress });
  return {
    id: uploaded.key,
    key: uploaded.key,
    name: uploaded.name,
    url: uploaded.url,
    type: uploaded.type,
    size: uploaded.size,
  };
}

function fileSubtitle(file: FileAttachment) {
  return [file.type, formatFileSize(file.size)].filter(Boolean).join(" / ");
}

function uploadProgressText(progress: UploadProgress) {
  if (progress.phase === "preparing") return propertyCellLabels().uploadPreparing;
  if (progress.phase === "finalizing") return propertyCellLabels().uploadFinishing;
  if (progress.phase === "complete") return propertyCellLabels().uploadComplete;
  return propertyCellLabels().uploadingProgress;
}

function storedWorkspaceFileKey(file: FileAttachment) {
  if (file.key?.startsWith("workspaces/")) return file.key;
  if (file.id.startsWith("workspaces/")) return file.id;
  return storageKeyFromUrl(file.url);
}

async function resolvedFileActionUrl(file: FileAttachment) {
  const key = storedWorkspaceFileKey(file);
  if (key) {
    try {
      return (await createWorkspaceFileDownloadUrl({ key })).url;
    } catch {
      // Fall back to the stored URL below when signing fails.
    }
  }
  return safeStoredFileUrl(file.url, ["data:"]);
}

function triggerFileDownload(url: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || "download";
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function FileThumb({
  file,
  className,
  iconSize,
}: {
  file: FileAttachment;
  className: string;
  iconSize: number;
}) {
  const isImage = isImageAttachment(file);
  const url = useWorkspaceFileUrl(file.url, ["data:image/"]);
  const style = isImage && url ? { backgroundImage: `url("${url.replace(/"/g, '\\"')}")` } : undefined;

  return (
    <span className={className} data-image={isImage ? "true" : undefined} style={style}>
      {!isImage && <FileText size={iconSize} aria-hidden="true" />}
    </span>
  );
}

function FileMenuText({
  file,
  subtitle,
}: {
  file: FileAttachment;
  subtitle: string;
}) {
  const content = (
    <>
      <span>{file.name}</span>
      {subtitle && <small>{subtitle}</small>}
    </>
  );

  return (
    <FileOpenLink file={file} className={styles.fileMenuText}>
      {content}
    </FileOpenLink>
  );
}

function FileOpenLink({
  file,
  className,
  children,
}: {
  file: FileAttachment;
  className: string;
  children: ReactNode;
}) {
  const href = useWorkspaceFileUrl(file.url);

  if (!href) return <span className={className}>{children}</span>;

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={propertyCellLabels().open(file.name)}
      onClick={(e) => e.stopPropagation()}
      onAuxClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}

function FilesCell({ row, prop }: { row: Page; prop: DbProperty }) {
  const setRowProperty = useStore((s) => s.setRowProperty);
  const [open, setOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [fileMenuId, setFileMenuId] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [renamingFileId, setRenamingFileId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<
    { fileName: string; phase: UploadProgress["phase"]; percent: number } | null
  >(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const files = normalizeFileAttachments(row.properties?.[prop.id]);
  const uploading = uploadProgress !== null;

  function commit(next: FileAttachment[]) {
    setRowProperty(row.id, prop.id, next.length ? next : null, { debounce: false });
  }

  function removeFile(id: string) {
    const removed = files.find((file) => file.id === id);
    commit(files.filter((file) => file.id !== id));
    const key = removed ? storedWorkspaceFileKey(removed) : "";
    if (key) {
      void deleteWorkspaceFile({ key }).catch(() => {
        setUploadError(propertyCellLabels().fileStoredDeleteFailed);
      });
    }
  }

  async function addUploads(list: FileList | null) {
    const selected = Array.from(list ?? []);
    if (selected.length === 0) return;
    setUploadError("");
    setOpen(true);
    setAddOpen(true);
    setUploadProgress({ fileName: selected[0]?.name || "Untitled", phase: "preparing", percent: 0 });
    try {
      const uploaded: FileAttachment[] = [];
      for (const [index, file] of selected.entries()) {
        const uploadedFile = await uploadFileAttachment(file, row, prop, (progress) => {
          const base = (index / selected.length) * 100;
          const span = 100 / selected.length;
          setUploadProgress({
            fileName: file.name || "Untitled",
            phase: progress.phase,
            percent: base + (progress.percent / 100) * span,
          });
        });
        uploaded.push(uploadedFile);
      }
      // Re-read the row's current files at commit time: uploads await the
      // network, and files added/removed during that window (a pasted link, a
      // second batch) would be clobbered by the stale render-closure snapshot.
      const currentFiles = normalizeFileAttachments(
        useStore.getState().pagesById[row.id]?.properties?.[prop.id]
      );
      commit([...currentFiles, ...uploaded]);
    } catch {
      setUploadError(propertyCellLabels().fileUploadFailed);
    } finally {
      setUploadProgress(null);
    }
  }

  function addLink() {
    const url = safeStoredFileUrl(link.trim());
    if (!url) {
      setUploadError(propertyCellLabels().pasteHttpFileLink);
      return;
    }
    commit([...files, { id: newId(), name: fileNameFromUrl(url), url }]);
    setUploadError("");
    setLink("");
  }

  async function downloadOne(file: FileAttachment) {
    const url = await resolvedFileActionUrl(file);
    if (!url) {
      setUploadError(propertyCellLabels().noDownloadUrl);
      return;
    }
    triggerFileDownload(url, file.name);
  }

  async function downloadAll() {
    let downloaded = 0;
    for (const file of files) {
      const url = await resolvedFileActionUrl(file);
      if (!url) continue;
      triggerFileDownload(url, file.name);
      downloaded += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }
    if (downloaded === 0) {
      setUploadError(propertyCellLabels().noDownloadUrl);
    }
  }

  async function openOriginal(file: FileAttachment) {
    const url = await resolvedFileActionUrl(file);
    if (!url) {
      setUploadError(propertyCellLabels().noOpenUrl);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  function startRename(file: FileAttachment) {
    setFileMenuId(null);
    setRenamingFileId(file.id);
    setRenameDraft(file.name);
  }

  function commitRename(fileId: string) {
    const nextName = renameDraft.trim();
    setRenamingFileId(null);
    if (!nextName) return;
    commit(files.map((file) => (file.id === fileId ? { ...file, name: nextName } : file)));
  }

  function openMenu() {
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    setAddOpen(false);
    setFileMenuId(null);
    setRenamingFileId(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMenu();
  }

  return (
    <div className={styles.filesCell}>
      <div
        ref={triggerRef}
        className={styles.filesChips}
        role="button"
        tabIndex={0}
        aria-label={propertyCellLabels().editFiles(prop.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
        onKeyDown={onTriggerKeyDown}
      >
        {files.map((file) => {
          return (
            <span key={file.id} className={styles.fileChip}>
              <FileOpenLink file={file} className={styles.fileChipLink}>
                <FileThumb file={file} className={styles.fileThumb} iconSize={13} />
                <span className={styles.fileName}>{file.name}</span>
              </FileOpenLink>
              <button
                type="button"
                aria-label={propertyCellLabels().remove(file.name)}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFile(file.id);
                }}
              >
                <X size={10} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        {files.length === 0 && <span className={styles.cellEmpty}>&nbsp;</span>}
      </div>
      {open && (
        <CellMenuPortal
          triggerRef={triggerRef}
          onClose={() => closeMenu(true)}
          ariaLabel={propertyCellLabels().editFilesProperty}
          className={styles.filesMenu}
          width={340}
          scroll={false}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.preventDefault();
            closeMenu(true);
          }}
        >
            <div className={styles.filesMenuHeader}>
              <button
                type="button"
                className={styles.filesMenuAction}
                onClick={() => setAddOpen((current) => !current)}
                aria-expanded={addOpen}
              >
                <Plus size={14} aria-hidden="true" />
                <span>{propertyCellLabels().addFileOrImage}</span>
              </button>
              {files.length > 0 && (
                <button
                  type="button"
                  className={styles.filesMenuAction}
                  onClick={() => void downloadAll()}
                >
                  <Download size={14} aria-hidden="true" />
                  <span>{propertyCellLabels().downloadAll}</span>
                </button>
              )}
            </div>
            {addOpen && (
              <div className={styles.filesMenuAddPanel}>
                <button
                  type="button"
                  className={styles.filesUploadButton}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  aria-busy={uploading}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{uploading ? propertyCellLabels().uploading : propertyCellLabels().uploadFromDevice}</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className={styles.fileInputHidden}
                  onChange={(e) => {
                    void addUploads(e.currentTarget.files);
                    e.currentTarget.value = "";
                  }}
                />
                {uploadProgress && (
                  <div
                    className={styles.filesUploadProgress}
                    role="status"
                    aria-live="polite"
                  >
                    <div className={styles.filesUploadProgressHeader}>
                      <span>{uploadProgressText(uploadProgress)}</span>
                      <strong>{Math.round(uploadProgress.percent)}%</strong>
                    </div>
                    <div className={styles.filesUploadProgressName}>{uploadProgress.fileName}</div>
                    <div
                      className={styles.filesUploadProgressTrack}
                      role="progressbar"
                      aria-label={propertyCellLabels().uploadingFile(uploadProgress.fileName)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(uploadProgress.percent)}
                    >
                      <span style={{ width: `${Math.max(4, Math.min(100, uploadProgress.percent))}%` }} />
                    </div>
                  </div>
                )}
                <div className={styles.fileLinkRow}>
                  <input
                    autoFocus
                    placeholder={propertyCellLabels().pasteFileUrl}
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (e.key === "Escape") closeMenu(true);
                      if (e.key === "Enter") addLink();
                    }}
                  />
                  <button type="button" onClick={addLink}>
                    {propertyCellLabels().add}
                  </button>
                </div>
              </div>
            )}
            {uploadError && <div className={styles.formulaWarning}>{uploadError}</div>}
            <div className={styles.filesMenuList} role="list">
              {files.map((file) => {
                const subtitle = fileSubtitle(file);
                const isRenaming = renamingFileId === file.id;
                return (
                  <div key={file.id} className={styles.filesMenuItem} role="listitem">
                    <FileThumb file={file} className={styles.fileMenuThumb} iconSize={15} />
                    {isRenaming ? (
                      <input
                        className={styles.fileRenameInput}
                        autoFocus
                        value={renameDraft}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={() => commitRename(file.id)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (isComposingKeyEvent(e)) return;
                          if (e.key === "Enter") commitRename(file.id);
                          if (e.key === "Escape") {
                            setRenamingFileId(null);
                            setRenameDraft("");
                          }
                        }}
                      />
                    ) : (
                      <FileMenuText file={file} subtitle={subtitle} />
                    )}
                    <button
                      type="button"
                      className={styles.fileActionButton}
                      aria-label={propertyCellLabels().downloadFile(file.name)}
                      title={propertyCellLabels().download}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFileMenuId(null);
                        void downloadOne(file);
                      }}
                    >
                      <Download size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={styles.fileActionButton}
                      aria-label={propertyCellLabels().fileMenu(file.name)}
                      aria-haspopup="menu"
                      aria-expanded={fileMenuId === file.id}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFileMenuId((current) => (current === file.id ? null : file.id));
                      }}
                    >
                      <DotsHorizontal size={14} aria-hidden="true" />
                    </button>
                    {fileMenuId === file.id && (
                      <div
                        className={styles.fileActionMenu}
                        role="menu"
                        tabIndex={-1}
                        aria-label={propertyCellLabels().fileActions(file.name)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <button type="button" role="menuitem" onClick={() => void downloadOne(file)}>
                          <Download size={14} aria-hidden="true" />
                          <span>{propertyCellLabels().download}</span>
                        </button>
                        <button type="button" role="menuitem" onClick={() => void openOriginal(file)}>
                          <OpenInNew size={14} aria-hidden="true" />
                          <span>{propertyCellLabels().viewOriginal}</span>
                        </button>
                        <button type="button" role="menuitem" onClick={() => startRename(file)}>
                          <FileText size={14} aria-hidden="true" />
                          <span>{propertyCellLabels().rename}</span>
                        </button>
                        <button type="button" role="menuitem" onClick={() => removeFile(file.id)}>
                          <Trash size={14} aria-hidden="true" />
                          <span>{propertyCellLabels().delete}</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
              {files.length === 0 && <div className={styles.selectEmpty}>{propertyCellLabels().noAttachments}</div>}
            </div>
        </CellMenuPortal>
      )}
    </div>
  );
}

function FormulaCell({ row, prop }: { row: Page; prop: DbProperty }) {
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const props = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const value = backendComputedText(row, prop) ?? formatFormulaValue(evaluateFormula({ row, prop, props, pagesById }));

  return (
    <span className={styles.rollupValue} title={value}>
      {value || " "}
    </span>
  );
}

function RelationCell({
  row,
  prop,
  onOpenPage,
}: {
  row: Page;
  prop: DbProperty;
  onOpenPage?: (pageId: string) => void;
}) {
  const router = useRouter();
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const hydratedRelationTargetIds = useStore((s) => s.hydratedRelationTargetIds);
  const loadDatabase = useStore((s) => s.loadDatabase);
  const setRelation = useStore((s) => s.setRelation);
  const addRow = useStore((s) => s.addRow);
  const updatePage = useStore((s) => s.updatePage);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const targetDbId = prop.config?.relationDatabaseId ?? prop.databaseId;
  const targetDb = pagesById[targetDbId];
  const selectedIds = valueAsIds(row.properties?.[prop.id]);
  const selectedSet = new Set(selectedIds);
  const selectedPages = selectedIds
    .map((id) => pagesById[id])
    .filter((page): page is Page => !!page && !page.inTrash);
  const loadedSelectedIds = new Set(selectedPages.map((page) => page.id));
  const unresolvedSelectedIds = selectedIds.filter((id) => !loadedSelectedIds.has(id));
  const pendingSelectedCount = unresolvedSelectedIds.filter(
    (id) => !hydratedRelationTargetIds.has(id)
  ).length;
  const missingSelectedCount = unresolvedSelectedIds.length - pendingSelectedCount;
  const candidates = Object.values(pagesById)
    .filter(
      (page) =>
        page.parentType === "database" &&
        page.parentId === targetDbId &&
        page.id !== row.id &&
        !page.inTrash
    )
    .sort((a, b) => a.position - b.position);
  const query = q.trim().toLowerCase();
  const filtered = candidates.filter((page) =>
    pageDisplayTitle(page).toLowerCase().includes(query)
  );
  const exact = candidates.some((page) => pageDisplayTitle(page).toLowerCase() === query);
  const canCreate = q.trim().length > 0 && !exact && targetDb?.kind === "database";
  const itemCount = filtered.length + (canCreate ? 1 : 0);
  const active = itemCount === 0 ? -1 : Math.min(activeIndex, itemCount - 1);
  const listId = `relation-list-${prop.id}-${row.id}`;

  useEffect(() => {
    if (targetDbId) void loadDatabase(targetDbId);
  }, [loadDatabase, targetDbId]);

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, filtered.length, canCreate]);

  function commit(ids: string[]) {
    setRelation(row.id, prop, ids);
  }

  function toggle(id: string) {
    commit(
      selectedSet.has(id)
        ? selectedIds.filter((item) => item !== id)
        : [...selectedIds, id]
    );
  }

  async function createRelatedPage() {
    if (!targetDb || targetDb.kind !== "database") return;
    const related = await addRow(targetDb.id);
    const title = q.trim();
    if (title) updatePage(related.id, { title });
    commit([...selectedIds, related.id]);
    setQ("");
  }

  function openMenu() {
    setOpen(true);
  }

  function openPage(pageId: string) {
    if (onOpenPage) onOpenPage(pageId);
    else router.push(pageHref(pageId));
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function optionId(index: number) {
    return `${listId}-option-${index}`;
  }

  function focusItem(index: number) {
    window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-relation-index="${index}"]`)
        ?.focus();
    });
  }

  function setActive(nextIndex: number, focus = false) {
    if (itemCount === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, itemCount - 1));
    setActiveIndex(bounded);
    if (focus) focusItem(bounded);
  }

  function moveActive(delta: number, focus = false) {
    if (itemCount === 0) return;
    setActive((active + delta + itemCount) % itemCount, focus);
  }

  function chooseActive() {
    if (active < 0) return;
    const page = filtered[active];
    if (page) {
      toggle(page.id);
      return;
    }
    if (canCreate) void createRelatedPage();
  }

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseActive();
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1, true);
    } else if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
      e.preventDefault();
      chooseActive();
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMenu();
  }

  function onRelationLinkClick(pageId: string, e: ReactMouseEvent<HTMLAnchorElement>) {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openPage(pageId);
  }

  return (
    <div className={styles.relationCell}>
      <div
        ref={triggerRef}
        className={styles.relationChips}
        role="button"
        tabIndex={0}
        aria-label={propertyCellLabels().editRelation(prop.name)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
        onKeyDown={onTriggerKeyDown}
      >
        {selectedPages.map((page) => (
          <span key={page.id} className={styles.relationChip} data-row-relation-chip>
            <span className={styles.relationPageIcon} aria-hidden="true">
              <PageIconGlyph page={page} size={13} />
            </span>
            <a
              className={styles.relationChipLink}
              href={pageHref(page.id)}
              aria-label={propertyCellLabels().open(pageDisplayTitle(page))}
              onClick={(e) => onRelationLinkClick(page.id, e)}
              onAuxClick={(e) => e.stopPropagation()}
            >
              {pageDisplayTitle(page)}
            </a>
            <button
              type="button"
              aria-label={propertyCellLabels().remove(pageDisplayTitle(page))}
              onClick={(e) => {
                e.stopPropagation();
                commit(selectedIds.filter((id) => id !== page.id));
              }}
            >
              <X size={10} aria-hidden="true" />
            </button>
          </span>
        ))}
        {pendingSelectedCount > 0 && (
          <span
            className={styles.relationChipSkeleton}
            data-row-relation-loading
            aria-label={propertyCellLabels().relationLoading}
          />
        )}
        {missingSelectedCount > 0 && (
          <span
            className={styles.relationMissingChip}
            data-row-relation-missing
            aria-label={propertyCellLabels().relationUnavailable}
          >
            {propertyCellLabels().unavailable}
          </span>
        )}
        {selectedIds.length === 0 && <span className={styles.cellEmpty}>&nbsp;</span>}
      </div>
      {open && (
        <CellMenuPortal
          triggerRef={triggerRef}
          onClose={() => closeMenu(true)}
          ariaLabel={propertyCellLabels().editRelationProperty}
          className={styles.relationMenu}
          width={280}
          scroll={false}
        >
            <input
              className={styles.relationSearch}
              autoFocus
              placeholder={
                targetDb
                  ? propertyCellLabels().searchPages(pageDisplayTitle(targetDb))
                  : propertyCellLabels().searchPagesFallback
              }
              value={q}
              role="combobox"
              aria-label={propertyCellLabels().searchRelatedPages}
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              onChange={(e) => {
                setQ(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
            <div
              id={listId}
              className={styles.relationList}
              ref={listRef}
              role="listbox"
              tabIndex={-1}
              aria-label={propertyCellLabels().relatedPages}
              aria-multiselectable="true"
              onKeyDown={onListKeyDown}
            >
              {filtered.map((page, index) => (
                <button
                  id={optionId(index)}
                  key={page.id}
                  type="button"
                  className={styles.relationOption}
                  role="option"
                  aria-selected={selectedSet.has(page.id)}
                  tabIndex={index === active ? 0 : -1}
                  data-active={index === active ? "true" : undefined}
                  data-relation-index={index}
                  data-selected={selectedSet.has(page.id) ? "true" : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onFocus={() => setActiveIndex(index)}
                  onClick={() => toggle(page.id)}
                >
                  <span className={styles.relationPageIcon} aria-hidden="true">
                    <PageIconGlyph page={page} size={15} />
                  </span>
                  <span className={styles.relationOptionTitle}>{pageDisplayTitle(page)}</span>
                  {selectedSet.has(page.id) && (
                    <span className={styles.check}>
                      <CheckIcon size={14} aria-hidden="true" />
                    </span>
                  )}
                </button>
              ))}
              {filtered.length === 0 && !q.trim() && (
                <div className={styles.selectEmpty}>
                  {targetDb
                    ? propertyCellLabels().noPagesYet
                    : propertyCellLabels().relationDatabaseUnavailable}
                </div>
              )}
              {filtered.length === 0 && q.trim() && !canCreate && (
                <div className={styles.selectEmpty}>{propertyCellLabels().noMatchingPages}</div>
              )}
              {canCreate && (
                <button
                  id={optionId(filtered.length)}
                  type="button"
                  className={styles.relationCreate}
                  role="option"
                  aria-selected={false}
                  tabIndex={filtered.length === active ? 0 : -1}
                  data-active={filtered.length === active ? "true" : undefined}
                  data-relation-index={filtered.length}
                  onMouseEnter={() => setActiveIndex(filtered.length)}
                  onFocus={() => setActiveIndex(filtered.length)}
                  onClick={() => void createRelatedPage()}
                >
                  <Plus size={14} aria-hidden="true" />
                  <span>{propertyCellLabels().newRelation(q.trim())}</span>
                </button>
              )}
            </div>
        </CellMenuPortal>
      )}
    </div>
  );
}

function RollupCell({ row, prop }: { row: Page; prop: DbProperty }) {
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const propsByDb = useStore(useShallow((s) => s.propsByDb));
  const computedValue = backendComputedText(row, prop);
  const sourceProps = useStore(useShallow((s) => s.dbProperties(prop.databaseId)));
  const relationProp = sourceProps.find(
    (item) => item.id === prop.config?.rollupRelationPropertyId
  );
  const targetDbId = relationProp?.config?.relationDatabaseId ?? relationProp?.databaseId;
  const targetProps = useStore(
    useShallow((s) => (targetDbId ? s.dbProperties(targetDbId) : []))
  );
  const loadDatabase = useStore((s) => s.loadDatabase);

  // Database reached by a second hop (when the target property is a relation or
  // rollup), so multi-hop rollups have the next database's properties loaded.
  const secondHopDbId = secondHopDatabaseId(prop, targetProps, propsByDb);

  useEffect(() => {
    if (targetDbId) void loadDatabase(targetDbId);
    if (secondHopDbId) void loadDatabase(secondHopDbId);
  }, [loadDatabase, targetDbId, secondHopDbId]);

  // Avoid flashing a wrong/empty value before the related database's
  // properties have loaded.
  const targetReady =
    !prop.config?.rollupTargetPropertyId ||
    targetProps.some((p) => p.id === prop.config?.rollupTargetPropertyId);

  const value = computedValue ?? (targetReady
    ? evaluateRollup({ row, prop, sourceProps, targetProps, pagesById, propsByDb })
    : "");

  return (
    <span className={styles.rollupValue} title={value}>
      {computedValue !== undefined || targetReady ? value || " " : <span className={styles.cellEmpty}>…</span>}
    </span>
  );
}

function SelectCell({
  row,
  prop,
  multi,
}: {
  row: Page;
  prop: DbProperty;
  multi: boolean;
}) {
  const updateProperty = useStore((s) => s.updateProperty);
  const deletePropertyOption = useStore((s) => s.deletePropertyOption);
  const restoreDeletedPropertyOption = useStore((s) => s.restoreDeletedPropertyOption);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const notify = useStore((s) => s.notify);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [colorPickerFor, setColorPickerFor] = useState<string | null>(null);
  const [colorPickerRect, setColorPickerRect] = useState<DOMRect | null>(null);
  const [draggingOptionId, setDraggingOptionId] = useState<string | null>(null);
  const [dragOverOptionId, setDragOverOptionId] = useState<string | null>(null);
  const [dragOverOptionSide, setDragOverOptionSide] = useState<"before" | "after">("before");
  const triggerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const options = prop.config?.options ?? [];
  const raw = row.properties?.[prop.id];
  const selectedIds: string[] = multi
    ? Array.isArray(raw)
      ? (raw as string[])
      : []
    : raw
      ? [String(raw)]
      : [];
  const selected = selectedIds
    .map((id) => options.find((o) => o.id === id))
    .filter(Boolean) as SelectOption[];

  function commit(ids: string[]) {
    setRowProperty(row.id, prop.id, multi ? ids : (ids[0] ?? null), { debounce: false });
  }
  function toggle(id: string) {
    if (multi) {
      const next = selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id];
      commit(next);
    } else {
      commit(selectedIds.includes(id) ? [] : [id]);
      closeMenu(true);
    }
  }
  function createOption(name: string) {
    const opt: SelectOption = {
      id: newId(),
      name,
      color: nextColor(options.length),
    };
    updateProperty(prop.id, { config: { ...prop.config, options: [...options, opt] } });
    toggle(opt.id);
    setQ("");
  }
  function removeSelected(id: string) {
    commit(selectedIds.filter((x) => x !== id));
  }
  function updateOptions(next: SelectOption[]) {
    updateProperty(prop.id, { config: { ...prop.config, options: next } });
  }
  function clearOptionDrag() {
    setDraggingOptionId(null);
    setDragOverOptionId(null);
    setDragOverOptionSide("before");
  }
  function optionDropSide(e: ReactDragEvent<HTMLElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  }
  function reorderOption(sourceId: string, targetId: string, side: "before" | "after") {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const source = options.find((option) => option.id === sourceId);
    if (!source || !options.some((option) => option.id === targetId)) return;
    const next = options.filter((option) => option.id !== sourceId);
    const targetIndex = next.findIndex((option) => option.id === targetId);
    if (targetIndex < 0) return;
    next.splice(targetIndex + (side === "after" ? 1 : 0), 0, source);
    updateOptions(next);
  }
  function setOptionColor(id: string, color: ColorName) {
    updateOptions(options.map((o) => (o.id === id ? { ...o, color } : o)));
    setColorPickerFor(null);
  }
  function renameOption(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    updateOptions(options.map((o) => (o.id === id ? { ...o, name: trimmed } : o)));
  }
  async function deleteOption(id: string) {
    const snapshot = await deletePropertyOption(prop.id, id);
    if (!snapshot) {
      notify(propertyCellLabels().deleteOptionFailed, "error");
      return;
    }
    notify(propertyCellLabels().deletedOption, "success", {
      label: propertyCellLabels().undo,
      onClick: async () => {
        const restored = await restoreDeletedPropertyOption(snapshot);
        notify(
          restored ? propertyCellLabels().restoredOption : propertyCellLabels().restoreOptionFailed,
          restored ? "success" : "error"
        );
      },
    });
  }

  const filtered = options.filter((o) =>
    o.name.toLowerCase().includes(q.toLowerCase())
  );
  const exact = options.some((o) => o.name.toLowerCase() === q.trim().toLowerCase());
  const canCreate = q.trim().length > 0 && !exact;
  const itemCount = filtered.length + (canCreate ? 1 : 0);
  const active = itemCount === 0 ? -1 : Math.min(activeIndex, itemCount - 1);
  const listId = `select-list-${prop.id}-${row.id}`;

  useEffect(() => {
    if (!open) return;
    listRef.current
      ?.querySelector(`[data-active="true"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, filtered.length, canCreate]);

  function openMenu() {
    setOpen(true);
  }

  function closeMenu(restoreFocus = false) {
    setOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }

  function optionId(index: number) {
    return `${listId}-option-${index}`;
  }

  function focusItem(index: number) {
    window.requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-select-index="${index}"]`)
        ?.focus();
    });
  }

  function setActive(nextIndex: number, focus = false) {
    if (itemCount === 0) return;
    const bounded = Math.max(0, Math.min(nextIndex, itemCount - 1));
    setActiveIndex(bounded);
    if (focus) focusItem(bounded);
  }

  function moveActive(delta: number, focus = false) {
    if (itemCount === 0) return;
    setActive((active + delta + itemCount) % itemCount, focus);
  }

  function chooseActive() {
    if (active < 0) return;
    const option = filtered[active];
    if (option) {
      toggle(option.id);
      return;
    }
    if (canCreate) createOption(q.trim());
  }

  function onSearchKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      chooseActive();
    }
  }

  function onListKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement;
    const optionTarget = target.closest("[data-select-index]");
    if (e.key === "Escape") {
      e.preventDefault();
      closeMenu(true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveActive(1, true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveActive(-1, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      moveActive(5, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      moveActive(-5, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0, true);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(itemCount - 1, true);
    } else if (e.key === "Enter" || e.key === " " || e.key === "Tab") {
      if (!optionTarget) return;
      e.preventDefault();
      chooseActive();
    }
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.target !== e.currentTarget) return;
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openMenu();
  }

  return (
    <div className={styles.selectCell}>
      <div
        ref={triggerRef}
        className={styles.chips}
        role="button"
        tabIndex={0}
        aria-label={
          multi
            ? propertyCellLabels().editMultiSelect(prop.name)
            : propertyCellLabels().editSelect(prop.name)
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openMenu}
        onKeyDown={onTriggerKeyDown}
      >
        {selected.map((o) => (
          <span key={o.id} className={styles.chip} style={chipStyle(o.color)}>
            {o.name}
            <button
              type="button"
              className={styles.chipRemove}
              aria-label={propertyCellLabels().remove(o.name)}
              onClick={(e) => {
                e.stopPropagation();
                removeSelected(o.id);
              }}
            >
              <X size={10} aria-hidden="true" />
            </button>
          </span>
        ))}
        {selected.length === 0 && <span className={styles.cellEmpty}>&nbsp;</span>}
      </div>
      {open && (
        <CellMenuPortal
          triggerRef={triggerRef}
          onClose={() => closeMenu(true)}
          ariaLabel={
            multi
              ? propertyCellLabels().editMultiSelectProperty
              : propertyCellLabels().editSelectProperty
          }
          className={styles.selectMenu}
          width={240}
          scroll={false}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeMenu(true);
            }
          }}
        >
            <input
              className={styles.selectSearch}
              autoFocus
              placeholder={propertyCellLabels().searchOrCreate}
              value={q}
              role="combobox"
              aria-label={propertyCellLabels().searchOptionsAria}
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              onChange={(e) => {
                setQ(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onSearchKeyDown}
            />
            <div
              id={listId}
              className={styles.selectList}
              ref={listRef}
              role="listbox"
              tabIndex={-1}
              aria-label={propertyCellLabels().options}
              aria-multiselectable={multi ? "true" : undefined}
              onKeyDown={onListKeyDown}
            >
              {filtered.map((o, index) => (
                <div
                  key={o.id}
                  className={styles.selectOpt}
                  data-active={index === active ? "true" : undefined}
                  data-option-id={o.id}
                  data-option-dragging={draggingOptionId === o.id ? "true" : undefined}
                  data-option-drag-over={dragOverOptionId === o.id ? "true" : undefined}
                  data-drop-side={dragOverOptionId === o.id ? dragOverOptionSide : undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onDragOver={(e) => {
                    const isOptionDrag =
                      draggingOptionId || Array.from(e.dataTransfer.types).includes(SELECT_OPTION_DRAG);
                    if (!isOptionDrag || draggingOptionId === o.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDragOverOptionId(o.id);
                    setDragOverOptionSide(optionDropSide(e));
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                    if (dragOverOptionId === o.id) {
                      setDragOverOptionId(null);
                      setDragOverOptionSide("before");
                    }
                  }}
                  onDrop={(e) => {
                    const sourceId = e.dataTransfer.getData(SELECT_OPTION_DRAG) || draggingOptionId;
                    if (!sourceId) return;
                    e.preventDefault();
                    e.stopPropagation();
                    reorderOption(sourceId, o.id, optionDropSide(e));
                    clearOptionDrag();
                  }}
                >
                  <span
                    className={styles.selectOptionDragHandle}
                    draggable
                    title={propertyCellLabels().dragOption(o.name)}
                    aria-label={propertyCellLabels().dragOption(o.name)}
                    data-select-option-drag-handle={o.id}
                    onDragStart={(e) => {
                      e.stopPropagation();
                      setDraggingOptionId(o.id);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData(SELECT_OPTION_DRAG, o.id);
                    }}
                    onDragEnd={clearOptionDrag}
                  >
                    <DragHandleIcon size={14} aria-hidden="true" />
                  </span>
                  <button
                    id={optionId(index)}
                    type="button"
                    className={styles.selectOptMain}
                    role="option"
                    aria-selected={selectedIds.includes(o.id)}
                    tabIndex={index === active ? 0 : -1}
                    data-select-index={index}
                    onFocus={() => setActiveIndex(index)}
                    onClick={() => toggle(o.id)}
                  >
                    <span className={styles.chip} style={chipStyle(o.color)}>
                      {o.name}
                    </span>
                    {selectedIds.includes(o.id) && (
                      <span className={styles.check}>
                        <CheckIcon size={14} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={styles.optionColorBtn}
                    title={propertyCellLabels().editOption}
                    aria-label={propertyCellLabels().edit(o.name)}
                    aria-haspopup="dialog"
                    aria-expanded={colorPickerFor === o.id}
                    onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setColorPickerFor((cur) => (cur === o.id ? null : o.id));
                      setColorPickerRect(rect);
                    }}
                  >
                    <span style={chipStyle(o.color)} />
                  </button>
                  <button
                    type="button"
                    className={styles.optionDeleteBtn}
                    title={propertyCellLabels().deleteOption}
                    aria-label={propertyCellLabels().deleteOption}
                    onClick={() => void deleteOption(o.id)}
                  >
                    <Trash size={13} aria-hidden="true" />
                  </button>
                </div>
              ))}
              {filtered.length === 0 && !q.trim() && (
                <div className={styles.selectEmpty}>{propertyCellLabels().noOptionsYet}</div>
              )}
              {canCreate && (
                <button
                  type="button"
                  id={optionId(filtered.length)}
                  className={styles.selectCreate}
                  role="option"
                  aria-selected={false}
                  tabIndex={filtered.length === active ? 0 : -1}
                  data-active={filtered.length === active ? "true" : undefined}
                  data-select-index={filtered.length}
                  onMouseEnter={() => setActiveIndex(filtered.length)}
                  onFocus={() => setActiveIndex(filtered.length)}
                  onClick={() => createOption(q.trim())}
                >
                  {propertyCellLabels().create}{" "}
                  <span className={styles.chip} style={chipStyle(nextColor(options.length))}>
                    {q.trim()}
                  </span>
                </button>
              )}
            </div>
        </CellMenuPortal>
      )}
      {colorPickerFor &&
        colorPickerRect &&
        (() => {
          const opt = options.find((o) => o.id === colorPickerFor);
          if (!opt) return null;
          const W = 196;
          const left = Math.min(
            Math.max(8, colorPickerRect.right - W),
            window.innerWidth - W - 8
          );
          const openUp = colorPickerRect.bottom + 130 > window.innerHeight;
          return createPortal(
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                tabIndex={-1}
                aria-label={propertyCellLabels().closeOptionEditor}
                style={{ zIndex: 1002 }}
                onClick={() => setColorPickerFor(null)}
              />
              <div
                className={styles.optionEditor}
                role="dialog"
                aria-label={propertyCellLabels().edit(opt.name)}
                style={{
                  position: "fixed",
                  left,
                  right: "auto",
                  top: openUp ? undefined : colorPickerRect.bottom + 4,
                  bottom: openUp ? window.innerHeight - colorPickerRect.top + 4 : undefined,
                  zIndex: 1003,
                }}
              >
                <input
                  className={styles.optionRename}
                  defaultValue={opt.name}
                  aria-label={propertyCellLabels().optionName}
                  autoFocus
                  onKeyDown={(e) => {
                    if (isComposingKeyEvent(e)) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      renameOption(opt.id, (e.target as HTMLInputElement).value);
                      setColorPickerFor(null);
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      setColorPickerFor(null);
                    }
                  }}
                  onBlur={(e) => renameOption(opt.id, e.target.value)}
                />
                <div className={styles.optionSwatches}>
                  {COLOR_NAMES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={styles.optionSwatch}
                      data-active={opt.color === color ? "true" : undefined}
                      title={color}
                      aria-label={color}
                      style={chipStyle(color)}
                      onClick={() => setOptionColor(opt.id, color)}
                    />
                  ))}
                </div>
              </div>
            </>,
            document.body
          );
        })()}
    </div>
  );
}

function NumberCell({
  prop,
  value,
  autoFocus,
  onCommit,
}: {
  prop: DbProperty;
  value: unknown;
  autoFocus?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const [editing, setEditing] = useState(!!autoFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const display = formatNumberValue(value, numberFormatForProperty(prop));

  useEffect(() => {
    if (editing) requestAnimationFrame(() => inputRef.current?.focus());
  }, [editing]);

  function commit() {
    // Tolerate grouping separators the display format adds (e.g. "1,000").
    const t = text.trim().replace(/[,\s]/g, "");
    const n = Number(t);
    onCommit(t === "" || Number.isNaN(n) ? null : n);
    setEditing(false);
  }

  if (!editing) {
    return (
      <button
        type="button"
        className={styles.numberDisplay}
        aria-label={propertyCellLabels().edit(prop.name)}
        onClick={() => {
          setText(value == null ? "" : String(value));
          setEditing(true);
        }}
      >
        {display || <span className={styles.cellEmpty}>&nbsp;</span>}
      </button>
    );
  }

  return (
    <input
      ref={inputRef}
      className={styles.cellInput}
      type="text"
      inputMode="decimal"
      autoFocus={autoFocus}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isComposingKeyEvent(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === "Escape") {
          setText(value == null ? "" : String(value));
          setEditing(false);
        }
      }}
    />
  );
}

// Rows and property definitions keep referential identity in the store unless
// they actually change, so memo skips re-rendering untouched cells when any
// sibling row updates.
export const PropertyCell = memo(PropertyCellImpl);

export { COLOR_NAMES };
