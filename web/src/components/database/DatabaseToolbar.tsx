"use client";

import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { i18next } from "@/i18n";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { databaseDisplayTitle, pageDisplayTitle } from "@/lib/pageTitle";
import {
  type Block,
  type DbProperty,
  type DbTemplate,
  type DbView,
  type DatabaseSubtaskViewConfig,
  type FilterGroup,
  type Page,
  type PropertyType,
  type ViewFilter,
  type ViewSort,
  type ViewType,
} from "@/lib/types";
import { useStore } from "@/lib/store";
import { hasDatabaseTemplateStoredFileReference } from "@/lib/storedFileReferences";
import { copyText } from "@/lib/clipboard";
import { absolutePageUrl } from "@/lib/navigation";
import {
  ArrowLeft,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  ClockIcon,
  Copy,
  DotsHorizontal,
  DoubleChevronRight,
  DragHandleIcon,
  EyeIcon,
  EyeSlashIcon,
  FileText,
  FilterIcon,
  LayoutIcon,
  LinkIcon,
  ListIcon,
  OpenAsPage,
  OpenInNew,
  Plus,
  PropertiesIcon,
  Search,
  SelectIcon,
  SharePeopleIcon,
  SortIcon,
  Star,
  StarFilled,
  StatusIcon,
  TableIcon,
  Trash,
  X,
} from "@/icons/hanji";
import { EmojiPicker } from "../EmojiPicker";
import { Editor } from "../editor/Editor";
import { RowProperties } from "./RowProperties";
import { NotionSelect } from "./NotionSelect";
import { PropertyTypeConfig } from "./PropertyTypeConfig";
import { PropertyTypeIcon } from "./PropertyTypeIcon";
import { DatabaseAutomationPanel } from "./DatabaseAutomationPanel";
import { isBoardMainGroupProperty } from "./boardGrouping";
import {
  CARD_PREVIEW_NONE,
  CARD_PREVIEW_PAGE,
  cardPreviewMode,
  isCoverProperty,
} from "./cardPreview";
import {
  configForType,
  CREATABLE_PROPERTY_TYPES,
  localizedPropertyTypeLabel,
  PROPERTY_TYPES,
} from "./propertyTypes";
import { usePropertyTypeChangeConfirm } from "./PropertyTypeChangeConfirm";
import {
  NO_VALUE_FILTERS,
  databaseViewLabels,
} from "./databaseViewLabels";
import {
  FilterGroupEditor,
  SortRow,
  defaultOperator,
  defaultValue,
  propertyTypeLabel,
} from "./DatabaseFilterEditors";
import {
  applyViewFilterSeeds,
  isQueryableProperty,
  orderViewProperties,
  TABLE_INITIAL_LOAD_OPTIONS,
  tableInitialLoadLimit,
  TIMELINE_LOAD_LIMIT_OPTIONS,
  timelineLoadLimit,
  viewFilterSeedValues,
} from "./query";
import styles from "./database.module.css";
import {
  INLINE_DATABASE_TOOLBAR_MENU_EVENT,
  NOTION_2023_VIEW_TYPES,
  TOOLBAR_PROPERTY_DRAG,
  TemplateIconGlyph,
  ViewTypeIcon,
  cloneViewConfigPart,
  countLeaves,
  databaseViewLink,
  editorBlocksToTemplateBlocks,
  effectiveOpenPageIn,
  onSegmentedOptionGroupKeyDown,
  readFilterTree,
  searchTerms,
  startsWithEmojiIcon,
  templateBlocksOrDefault,
  templateBlocksToEditorBlocks,
  templateBodyPlaceholder,
  templateDisplayName,
  templateEditorPageId,
  templateNameValue,
  templateTitleValue,
  updateGroupAtPath,
  viewTypeSettingsLabel,
} from "./databaseViewShared";
type ToolbarMenu =
  | "settings"
  | "automations"
  | "additionalSettings"
  | "subitemsSettings"
  | "subitemsAdvancedSettings"
  | "dependenciesSettings"
  | "taskFeatureTurnOffConfirmation"
  | "layout"
  | "group"
  | "properties"
  | "sourceProperties"
  | "filter"
  | "sort"
  | "templates";

function toolbarMenuWidth(menu: ToolbarMenu) {
  if (
    menu === "settings"
    || menu === "automations"
    || menu === "additionalSettings"
    || menu === "subitemsSettings"
    || menu === "subitemsAdvancedSettings"
    || menu === "dependenciesSettings"
    || menu === "taskFeatureTurnOffConfirmation"
  ) return 300;
  if (menu === "layout") return 560;
  if (menu === "group") return 320;
  if (menu === "properties") return 360;
  if (menu === "sourceProperties") return 320;
  if (menu === "filter" || menu === "sort") return 520;
  return 360;
}

function placeToolbarMenu(trigger: HTMLElement, menu: ToolbarMenu): CSSProperties {
  const margin = 8;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(240, Math.min(toolbarMenuWidth(menu), window.innerWidth - margin * 2));
  const preferredLeft = menu === "templates" ? rect.right - width : rect.left;
  const left = Math.min(
    Math.max(margin, preferredLeft),
    Math.max(margin, window.innerWidth - width - margin)
  );
  const top = Math.max(margin, Math.min(rect.bottom + 8, window.innerHeight - margin - 180));
  return {
    position: "fixed",
    top,
    right: "auto",
    left,
    width,
    maxWidth: `calc(100vw - ${margin * 2}px)`,
    maxHeight: Math.max(180, window.innerHeight - top - margin),
  };
}

function isVisibleToolbarItem(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

export function DatabaseToolbar({
  dbId,
  view,
  compactImportedInline = false,
  readOnly = false,
  search,
  searchFocusTick = 0,
  contextPageId,
  onSearchChange,
  onOpenRow,
}: {
  dbId: string;
  view: DbView;
  compactImportedInline?: boolean;
  readOnly?: boolean;
  search: string;
  searchFocusTick?: number;
  contextPageId?: string;
  onSearchChange: (search: string) => void;
  onOpenRow?: (pageId: string) => void;
}) {
  const props = useStore(useShallow((s) => s.dbProperties(dbId)));
  const databaseViews = useStore(useShallow((s) => s.dbViews(dbId)));
  const templates = useStore(useShallow((s) => s.dbTemplates(dbId)));
  const pagesById = useStore(useShallow((s) => s.pagesById));
  const configureDatabaseTaskFeature = useStore((s) => s.configureDatabaseTaskFeature);
  const updateView = useStore((s) => s.updateView);
  const addProperty = useStore((s) => s.addProperty);
  const updateProperty = useStore((s) => s.updateProperty);
  const deleteProperty = useStore((s) => s.deleteProperty);
  const notify = useStore((s) => s.notify);
  const addRow = useStore((s) => s.addRow);
  const setRowProperty = useStore((s) => s.setRowProperty);
  const updatePage = useStore((s) => s.updatePage);
  const addTemplate = useStore((s) => s.addTemplate);
  const duplicateTemplate = useStore((s) => s.duplicateTemplate);
  const updateTemplate = useStore((s) => s.updateTemplate);
  const deleteTemplate = useStore((s) => s.deleteTemplate);
  const restoreDeletedTemplate = useStore((s) => s.restoreDeletedTemplate);
  const [open, setOpen] = useState<ToolbarMenu | null>(null);
  const [toolbarMenuStyle, setToolbarMenuStyle] = useState<CSSProperties | undefined>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [pendingRuleFocus, setPendingRuleFocus] = useState<"filter" | "sort" | null>(null);
  const [propertiesReturnMenu, setPropertiesReturnMenu] = useState<ToolbarMenu | null>(null);
  const [sourcePropertyDetailId, setSourcePropertyDetailId] = useState<string | null>(null);
  const [sourcePropertyCreateOpen, setSourcePropertyCreateOpen] = useState(false);
  const [draggingPropertyId, setDraggingPropertyId] = useState<string | null>(null);
  const [dragOverPropertyId, setDragOverPropertyId] = useState<string | null>(null);
  const [dragOverPropertySide, setDragOverPropertySide] = useState<"before" | "after">("before");
  const [subitemsActivationBusy, setSubitemsActivationBusy] = useState(false);
  const subitemsActivationBusyRef = useRef(false);
  const [subitemNestedPropertyId, setSubitemNestedPropertyId] = useState("");
  const [subitemShowToggleOnTitle, setSubitemShowToggleOnTitle] = useState(true);
  const [dependencyActivationBusy, setDependencyActivationBusy] = useState(false);
  const dependencyActivationBusyRef = useRef(false);
  const [dependencyDatePropertyId, setDependencyDatePropertyId] = useState("");
  const [dependencySeparateDates, setDependencySeparateDates] = useState(false);
  const [dependencyStartDatePropertyId, setDependencyStartDatePropertyId] = useState("");
  const [dependencyEndDatePropertyId, setDependencyEndDatePropertyId] = useState("");
  const [dependencyShiftMode, setDependencyShiftMode] = useState<
    "overlap" | "maintain_spacing" | "none"
  >("overlap");
  const [dependencyAvoidWeekends, setDependencyAvoidWeekends] = useState(true);
  const [turnOffFeature, setTurnOffFeature] = useState<"dependencies" | "subitems">("subitems");
  const [turnOffPropertyDisposition, setTurnOffPropertyDisposition] = useState<"keep" | "remove">(
    "remove"
  );
  const toolbarRootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const toolbarMenuRef = useRef<HTMLDivElement>(null);
  const activeToolbarButtonRef = useRef<HTMLElement | null>(null);
  const templateEditorReturnFocusRef = useRef<HTMLElement | null>(null);
  const { confirmPropertyTypeChange, typeChangeConfirmDialog } = usePropertyTypeChangeConfirm();
  const filterTree = readFilterTree(view.config);
  const filterCount = countLeaves(filterTree);
  const hasFilterTerms = filterCount > 0 || (filterTree.groups?.length ?? 0) > 0;
  const sorts = view.config?.sorts ?? [];
  const [propertySearch, setPropertySearch] = useState("");
  const [templateSearch, setTemplateSearch] = useState("");
  const templateSearchRef = useRef<HTMLInputElement>(null);
  const orderedProps = orderViewProperties(props, view);
  const queryableProps = props.filter(isQueryableProperty);
  const hasActiveFilterTerms = hasFilterTerms;
  const hiddenIds = new Set(view.config?.hiddenProperties ?? []);
  const titlePropertyId = props.find((p) => p.type === "title")?.id;
  const visibleIds = new Set(
    view.config?.visibleProperties ?? props.filter((p) => !hiddenIds.has(p.id)).map((p) => p.id)
  );
  const hiddenCount = props.filter((p) => p.type !== "title" && !visibleIds.has(p.id)).length;
  const propertySearchTerms = searchTerms(propertySearch);
  const sourcePropertyDetail = props.find((prop) => prop.id === sourcePropertyDetailId);
  const sourcePropertyEditorProps = propertySearchTerms.length > 0
    ? props.filter((prop) => {
        const haystack = `${prop.name} ${propertyTypeLabel(prop)} ${prop.description ?? ""}`.toLowerCase();
        return propertySearchTerms.every((term) => haystack.includes(term));
      })
    : props;
  const filteredOrderedProps = propertySearchTerms.length > 0
    ? orderedProps.filter((prop) => {
        const haystack = `${prop.name} ${propertyTypeLabel(prop)} ${prop.description ?? ""}`.toLowerCase();
        return propertySearchTerms.every((term) => haystack.includes(term));
      })
    : orderedProps;
  const visibleFilteredProps = filteredOrderedProps.filter(
    (prop) => prop.type === "title" || visibleIds.has(prop.id)
  );
  const hiddenFilteredProps = filteredOrderedProps.filter(
    (prop) => prop.type !== "title" && !visibleIds.has(prop.id)
  );
  const isCardView = view.type === "board" || view.type === "gallery";
  const isCalendarView = view.type === "calendar";
  const isTimelineView = view.type === "timeline";
  const isBoardView = view.type === "board";
  const dateProps = props.filter((prop) => prop.type === "date");
  const subitemsBinding = pagesById[dbId]?.databaseFeatures?.subitems;
  const subitemsEnabled = subitemsBinding?.enabled === true;
  const configuredSubitemNestedPropertyId = subitemsBinding?.nestedPropertyId;
  const currentSubitemNestedPropertyId =
    configuredSubitemNestedPropertyId
    && (configuredSubitemNestedPropertyId === subitemsBinding?.parentPropertyId
      || configuredSubitemNestedPropertyId === subitemsBinding?.childrenPropertyId)
      ? configuredSubitemNestedPropertyId
      : subitemsBinding?.childrenPropertyId ?? "";
  const currentSubitemShowToggleOnTitle = subitemsBinding?.showToggleOnTitle !== false;
  const isRowSubitemView =
    view.type === "table" || view.type === "list" || view.type === "timeline";
  const isCardSubitemView =
    view.type === "board" || view.type === "calendar" || view.type === "gallery";
  const subitemViewSettingsVisible =
    subitemsEnabled && (isRowSubitemView || isCardSubitemView);
  const subitemDisplayMode =
    view.config?.subtasks?.displayMode === "flattened" ? "flattened" : "show";
  const subitemFilterScope = isCardSubitemView
    ? "parents"
    : view.config?.subtasks?.filterScope ?? "parents_and_subitems";
  const subitemDisplayOptions = isCardSubitemView
    ? [
        { value: "show", label: databaseViewLabels().cardProperty },
        { value: "flattened", label: databaseViewLabels().flattenedList },
      ]
    : [
        { value: "show", label: databaseViewLabels().nestedInToggle },
        { value: "flattened", label: databaseViewLabels().flattenedList },
      ];
  const dependenciesBinding = pagesById[dbId]?.databaseFeatures?.dependencies;
  const dependenciesEnabled = dependenciesBinding?.enabled === true;
  const dependencyDateBindingUnchanged = dependencySeparateDates
    ? dependenciesBinding?.dateMode === "separate"
      && dependencyStartDatePropertyId === dependenciesBinding.startDatePropertyId
      && dependencyEndDatePropertyId === dependenciesBinding.endDatePropertyId
    : dependenciesBinding?.dateMode !== "separate"
      && dependencyDatePropertyId === dependenciesBinding?.datePropertyId;
  const dependencySettingsUnchanged = dependenciesEnabled
    && dependencyDateBindingUnchanged
    && dependencyShiftMode === dependenciesBinding.shiftMode
    && dependencyAvoidWeekends === dependenciesBinding.avoidWeekends;
  const dependencyDateBindingValid = dependencySeparateDates
    ? Boolean(
        dependencyStartDatePropertyId
        && dependencyEndDatePropertyId
        && dependencyStartDatePropertyId !== dependencyEndDatePropertyId
      )
    : Boolean(dependencyDatePropertyId);
  const coverProps = props.filter(isCoverProperty);
  const groupProps = props.filter(isBoardMainGroupProperty);
  const activeGroupProp =
    groupProps.find((prop) => prop.id === view.config?.groupBy) ?? groupProps[0];
  const activeTimelineStartId =
    view.config?.timelineBy ?? view.config?.calendarBy ?? dateProps[0]?.id;
  const coverPropertyOptions = [
    { value: CARD_PREVIEW_PAGE, label: databaseViewLabels().pageCover },
    { value: CARD_PREVIEW_NONE, label: databaseViewLabels().none },
    ...coverProps.map((prop) => ({
      value: prop.id,
      label: prop.name || databaseViewLabels().untitled,
      icon: <PropertyTypeIcon type={prop.type} size={14} />,
    })),
  ];
  const cardPreviewValue = isBoardView
    ? view.config?.coverProperty ?? CARD_PREVIEW_NONE
    : cardPreviewMode(view.config?.coverProperty);
  const datePropertyOptions =
    dateProps.length > 0
      ? dateProps.map((prop) => ({
          value: prop.id,
          label: prop.name || databaseViewLabels().untitled,
          icon: <PropertyTypeIcon type={prop.type} size={14} />,
        }))
      : [{ value: "", label: databaseViewLabels().noDateProperties, disabled: true }];
  const timelineEndPropertyOptions = [
    { value: "", label: databaseViewLabels().none },
    ...dateProps
      .filter((prop) => prop.id !== activeTimelineStartId)
      .map((prop) => ({
        value: prop.id,
        label: prop.name || databaseViewLabels().untitled,
        icon: <PropertyTypeIcon type={prop.type} size={14} />,
      })),
  ];
  const layoutActive =
    !!view.config?.wrap ||
    !!view.config?.fitImage ||
    !!view.config?.calendarLayout ||
    !!view.config?.cardSize ||
    !!view.config?.coverProperty ||
    !!view.config?.calendarBy ||
    !!view.config?.timelineBy ||
    !!view.config?.timelineEndBy ||
    !!view.config?.timelineZoom ||
    !!view.config?.timelineShowTable ||
    !!view.config?.timelineLoadLimit ||
    !!view.config?.subtasks ||
    !!view.config?.openPageIn ||
    !!view.config?.rowHeight ||
    !!view.config?.initialLoadLimit;
  const showLayoutOptions = !compactImportedInline;
  const showDirectProperties = !compactImportedInline;
  const openPageIn = effectiveOpenPageIn(view);
  const rowHeight = view.config?.rowHeight ?? "medium";
  const initialLoadLimit = tableInitialLoadLimit(view);
  const timelineLimit = timelineLoadLimit(view);
  const defaultTemplate = templates.find((template) => template.isDefault);
  const newPageLabel = compactImportedInline ? databaseViewLabels().toolbarNew : databaseViewLabels().toolbarNew;
  const editingTemplate = templates.find((template) => template.id === editingTemplateId);
  const templateSearchTerms = searchTerms(templateSearch);
  const filteredTemplates =
    templateSearchTerms.length > 0
      ? templates.filter((template) => {
          const haystack = `${templateNameValue(template)} ${templateTitleValue(template)}`.toLowerCase();
          return templateSearchTerms.every((term) => haystack.includes(term));
        })
      : templates;

  function updateConfig(config: Partial<DbView["config"]>) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, ...config } });
  }

  function updateSubitemViewConfig(
    patch: Partial<Pick<DatabaseSubtaskViewConfig, "displayMode" | "filterScope">>
  ) {
    if (readOnly || !subitemsEnabled || !subitemsBinding) return;
    const current = view.config?.subtasks;
    updateConfig({
      subtasks: {
        displayMode: patch.displayMode ?? current?.displayMode ?? "show",
        filterScope: isCardSubitemView
          ? "parents"
          : patch.filterScope ?? current?.filterScope ?? "parents_and_subitems",
        propertyId: currentSubitemNestedPropertyId,
        toggleColumnId: currentSubitemShowToggleOnTitle
          ? titlePropertyId ?? currentSubitemNestedPropertyId
          : currentSubitemNestedPropertyId,
      },
    });
  }

  function updateViewType(type: ViewType) {
    if (readOnly) return;
    if (type === view.type) return;
    updateView(view.id, { type });
  }

  useEffect(() => {
    subitemsActivationBusyRef.current = false;
    setSubitemsActivationBusy(false);
  }, [subitemsBinding?.revision, subitemsEnabled]);

  useEffect(() => {
    dependencyActivationBusyRef.current = false;
    setDependencyActivationBusy(false);
  }, [dependenciesBinding?.revision, dependenciesEnabled]);

  async function activateSubitems() {
    if (readOnly || subitemsEnabled || subitemsActivationBusyRef.current) return;
    subitemsActivationBusyRef.current = true;
    setSubitemsActivationBusy(true);
    try {
      const status = await configureDatabaseTaskFeature({
        childrenPropertyName: databaseViewLabels().subitemPropertyName,
        databaseId: dbId,
        feature: "subitems",
        parentPropertyName: databaseViewLabels().parentItemPropertyName,
      });
      if (status !== "queued") {
        subitemsActivationBusyRef.current = false;
        setSubitemsActivationBusy(false);
      }
    } catch {
      subitemsActivationBusyRef.current = false;
      setSubitemsActivationBusy(false);
    }
  }

  function openSubitemAdvancedSettings() {
    if (!subitemsBinding) return;
    setSubitemNestedPropertyId(currentSubitemNestedPropertyId);
    setSubitemShowToggleOnTitle(currentSubitemShowToggleOnTitle);
    openRelatedToolbarMenu("subitemsAdvancedSettings");
  }

  const subitemAdvancedSettingsUnchanged =
    subitemNestedPropertyId === currentSubitemNestedPropertyId
    && subitemShowToggleOnTitle === currentSubitemShowToggleOnTitle;

  async function saveSubitemAdvancedSettings() {
    if (
      readOnly
      || !subitemsBinding
      || !subitemsEnabled
      || subitemsActivationBusyRef.current
      || subitemAdvancedSettingsUnchanged
    ) return;
    subitemsActivationBusyRef.current = true;
    setSubitemsActivationBusy(true);
    try {
      const status = await configureDatabaseTaskFeature({
        childrenPropertyName: databaseViewLabels().subitemPropertyName,
        databaseId: dbId,
        feature: "subitems",
        nestedPropertyId: subitemNestedPropertyId,
        parentPropertyName: databaseViewLabels().parentItemPropertyName,
        showToggleOnTitle: subitemShowToggleOnTitle,
      });
      if (status !== "queued") {
        subitemsActivationBusyRef.current = false;
        setSubitemsActivationBusy(false);
      }
    } catch {
      subitemsActivationBusyRef.current = false;
      setSubitemsActivationBusy(false);
    }
  }

  function openDependenciesSettings() {
    const storedSeparateDates = dependenciesBinding?.dateMode === "separate";
    const storedDatePropertyId = storedSeparateDates
      ? dependenciesBinding.startDatePropertyId
      : (dependenciesBinding?.datePropertyId ?? "");
    const nextDatePropertyId = dateProps.some((property) => property.id === storedDatePropertyId)
      ? storedDatePropertyId
      : (dateProps[0]?.id ?? "");
    const storedEndDatePropertyId = storedSeparateDates
      ? dependenciesBinding.endDatePropertyId
      : "";
    const nextEndDatePropertyId = dateProps.some(
      (property) => property.id === storedEndDatePropertyId && property.id !== nextDatePropertyId
    )
      ? storedEndDatePropertyId
      : (dateProps.find((property) => property.id !== nextDatePropertyId)?.id ?? "");
    setDependencyDatePropertyId(
      nextDatePropertyId
    );
    setDependencySeparateDates(storedSeparateDates);
    setDependencyStartDatePropertyId(nextDatePropertyId);
    setDependencyEndDatePropertyId(nextEndDatePropertyId);
    setDependencyShiftMode(dependenciesBinding?.shiftMode ?? "overlap");
    setDependencyAvoidWeekends(dependenciesBinding?.avoidWeekends ?? true);
    openRelatedToolbarMenu("dependenciesSettings");
  }

  function setDependencyDateMode(separateDates: boolean) {
    if (separateDates) {
      const startDatePropertyId = dateProps.some(
        (property) => property.id === dependencyDatePropertyId
      )
        ? dependencyDatePropertyId
        : (dateProps[0]?.id ?? "");
      const endDatePropertyId = dateProps.some(
        (property) => property.id === dependencyEndDatePropertyId
          && property.id !== startDatePropertyId
      )
        ? dependencyEndDatePropertyId
        : (dateProps.find((property) => property.id !== startDatePropertyId)?.id ?? "");
      setDependencyStartDatePropertyId(startDatePropertyId);
      setDependencyEndDatePropertyId(endDatePropertyId);
    } else {
      setDependencyDatePropertyId(dependencyStartDatePropertyId || dateProps[0]?.id || "");
    }
    setDependencySeparateDates(separateDates);
  }

  async function activateDependencies() {
    if (readOnly || !dependencyDateBindingValid || dependencyActivationBusyRef.current) return;
    dependencyActivationBusyRef.current = true;
    setDependencyActivationBusy(true);
    try {
      const dateBinding = dependencySeparateDates
        ? {
            dateMode: "separate" as const,
            endDatePropertyId: dependencyEndDatePropertyId,
            startDatePropertyId: dependencyStartDatePropertyId,
          }
        : { datePropertyId: dependencyDatePropertyId };
      const status = await configureDatabaseTaskFeature({
        avoidWeekends: dependencyAvoidWeekends,
        databaseId: dbId,
        ...dateBinding,
        feature: "dependencies",
        predecessorPropertyName: databaseViewLabels().blockedByPropertyName,
        shiftMode: dependencyShiftMode,
        successorPropertyName: databaseViewLabels().blockingPropertyName,
      });
      if (status !== "queued") {
        dependencyActivationBusyRef.current = false;
        setDependencyActivationBusy(false);
      }
    } catch {
      dependencyActivationBusyRef.current = false;
      setDependencyActivationBusy(false);
    }
  }

  function openTaskFeatureTurnOff(feature: "dependencies" | "subitems") {
    if (readOnly) return;
    setTurnOffFeature(feature);
    setTurnOffPropertyDisposition("remove");
    openRelatedToolbarMenu("taskFeatureTurnOffConfirmation");
  }

  async function confirmTaskFeatureTurnOff() {
    const isSubitems = turnOffFeature === "subitems";
    const busyRef = isSubitems ? subitemsActivationBusyRef : dependencyActivationBusyRef;
    const setBusy = isSubitems ? setSubitemsActivationBusy : setDependencyActivationBusy;
    if (
      readOnly
      || busyRef.current
      || (isSubitems ? !subitemsEnabled : !dependenciesEnabled)
    ) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const status = await configureDatabaseTaskFeature({
        databaseId: dbId,
        enabled: false,
        feature: turnOffFeature,
        propertyDisposition: turnOffPropertyDisposition,
      });
      if (status !== "queued") {
        busyRef.current = false;
        setBusy(false);
      }
      openRelatedToolbarMenu("additionalSettings");
    } catch {
      busyRef.current = false;
      setBusy(false);
    }
  }

  // Single immutable writer for the whole filter tree. Clears the legacy flat
  // `filters`/`filterConjunction` so `filterGroup` is unambiguously the source of
  // truth (applyView prefers it regardless, but this keeps configs clean).
  function setFilterTree(next: FilterGroup) {
    if (readOnly) return;
    updateView(view.id, {
      config: {
        ...view.config,
        filterGroup: next,
        filters: undefined,
        filterConjunction: undefined,
        quickFilters: undefined,
      },
    });
  }

  function setSorts(next: ViewSort[]) {
    if (readOnly) return;
    updateView(view.id, { config: { ...view.config, sorts: next } });
  }

  function handleSearchChange(next: string) {
    onSearchChange(next);
  }
  function clearSearchNow() {
    onSearchChange("");
  }

  const closeToolbarMenu = useCallback((restoreFocus = false) => {
    setOpen(null);
    setToolbarMenuStyle(undefined);
    setPropertySearch("");
    setPropertiesReturnMenu(null);
    setSourcePropertyDetailId(null);
    setSourcePropertyCreateOpen(false);
    setTemplateSearch("");
    clearPropertyDragState();
    if (restoreFocus) {
      window.requestAnimationFrame(() => activeToolbarButtonRef.current?.focus());
    }
  }, []);

  function toggleMenu(menu: ToolbarMenu, trigger: HTMLButtonElement) {
    if (readOnly) return;
    setSearchOpen(false);
    const propertyMenuOpening = menu === "properties" || menu === "sourceProperties";
    const propertyMenuAlreadyOpen = open === "properties" || open === "sourceProperties";
    if (!propertyMenuOpening || !propertyMenuAlreadyOpen) setPropertySearch("");
    if (menu !== "sourceProperties") {
      setSourcePropertyDetailId(null);
      setSourcePropertyCreateOpen(false);
    }
    if (menu !== "templates" || open !== "templates") setTemplateSearch("");
    setPropertiesReturnMenu(null);
    activeToolbarButtonRef.current = trigger;
    if (open === menu) closeToolbarMenu(true);
    else {
      setToolbarMenuStyle(placeToolbarMenu(trigger, menu));
      setOpen(menu);
    }
  }

  function openRelatedToolbarMenu(menu: ToolbarMenu) {
    if (readOnly) return;
    const trigger = activeToolbarButtonRef.current;
    if (!trigger) return;
    if (menu === "sourceProperties") {
      setSourcePropertyDetailId(null);
      setSourcePropertyCreateOpen(false);
    }
    setPropertiesReturnMenu(
      (menu === "properties" || menu === "sourceProperties") && open === "settings" ? "settings" : null
    );
    setToolbarMenuStyle(placeToolbarMenu(trigger, menu));
    setOpen(menu);
  }

  function goBackFromPropertiesMenu() {
    if (open === "sourceProperties" && sourcePropertyDetailId) {
      setSourcePropertyDetailId(null);
      return;
    }
    if (open === "sourceProperties" && sourcePropertyCreateOpen) {
      setSourcePropertyCreateOpen(false);
      return;
    }
    const trigger = activeToolbarButtonRef.current;
    if (propertiesReturnMenu && trigger) {
      setPropertySearch("");
      setPropertiesReturnMenu(null);
      setToolbarMenuStyle(placeToolbarMenu(trigger, propertiesReturnMenu));
      setOpen(propertiesReturnMenu);
      return;
    }
    closeToolbarMenu(true);
  }

  async function copyActiveViewLink() {
    const copied = await copyText(databaseViewLink(dbId, view.id));
    notify(
      copied ? databaseViewLabels().copiedViewLink : databaseViewLabels().copyViewLinkFailed,
      copied ? "success" : "error"
    );
    closeToolbarMenu(true);
  }

  function renderToolbarMenuLayer(children: ReactNode) {
    return typeof document === "undefined" ? children : createPortal(children, document.body);
  }

  useEffect(() => {
    const toolbarRoot = toolbarRootRef.current;
    const databaseRoot = toolbarRoot?.closest<HTMLElement>('[data-placement="inline"]');
    if (!toolbarRoot || !databaseRoot) return;
    const toolbarTrigger = toolbarRoot;
    function onOpenInlineToolbarMenu(event: Event) {
      if (readOnly) return;
      const menu = (event as CustomEvent<{ menu?: ToolbarMenu }>).detail?.menu;
      if (
        menu !== "settings" &&
        menu !== "layout" &&
        menu !== "properties" &&
        menu !== "sourceProperties" &&
        menu !== "filter" &&
        menu !== "sort"
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(false);
      setPropertySearch("");
      setTemplateSearch("");
      setPropertiesReturnMenu(null);
      if (menu === "sourceProperties") {
        setSourcePropertyDetailId(null);
        setSourcePropertyCreateOpen(false);
      }
      activeToolbarButtonRef.current = toolbarTrigger;
      setToolbarMenuStyle(placeToolbarMenu(toolbarTrigger, menu));
      setOpen(menu);
    }
    databaseRoot.addEventListener(INLINE_DATABASE_TOOLBAR_MENU_EVENT, onOpenInlineToolbarMenu);
    return () => databaseRoot.removeEventListener(INLINE_DATABASE_TOOLBAR_MENU_EVENT, onOpenInlineToolbarMenu);
  }, [readOnly]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = activeToolbarButtonRef.current;
      if (!trigger) return;
      setToolbarMenuStyle(placeToolbarMenu(trigger, open));
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  function toolbarMenuItems() {
    return Array.from(
      toolbarMenuRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((element) => isVisibleToolbarItem(element) && element.tabIndex >= 0);
  }

  function onToolbarMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeToolbarMenu(true);
      return;
    }
    if (e.key === "Tab") {
      const items = toolbarMenuItems();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        e.stopPropagation();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        e.stopPropagation();
        first.focus();
      }
      return;
    }
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement) return;
    if (target instanceof HTMLInputElement && target.type !== "checkbox") return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;

    const items = toolbarMenuItems();
    if (items.length === 0) return;

    e.preventDefault();
    e.stopPropagation();
    const index = items.findIndex((item) => item === document.activeElement);
    let nextIndex = index >= 0 ? index : 0;
    if (e.key === "ArrowDown") {
      nextIndex = index >= 0 ? (index + 1) % items.length : 0;
    } else if (e.key === "ArrowUp") {
      nextIndex = index > 0 ? index - 1 : items.length - 1;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = items.length - 1;
    }

    items[nextIndex]?.focus();
  }

  useEffect(() => {
    if (searchOpen) requestAnimationFrame(() => searchRef.current?.focus());
  }, [searchOpen]);

  useEffect(() => {
    if (searchFocusTick <= 0) return;
    let focusFrame: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      setOpen(null);
      setSearchOpen(true);
      focusFrame = window.requestAnimationFrame(() => {
        searchRef.current?.focus();
        searchRef.current?.select();
      });
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (focusFrame) window.cancelAnimationFrame(focusFrame);
    };
  }, [searchFocusTick]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      if (open === "templates") templateSearchRef.current?.focus();
      else toolbarMenuItems()[0]?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!pendingRuleFocus) return;
    const selector = pendingRuleFocus === "filter" ? "[data-filter-row]" : "[data-sort-row]";
    const frame = window.requestAnimationFrame(() => {
      const rows = toolbarMenuRef.current?.querySelectorAll<HTMLElement>(selector) ?? [];
      rows[rows.length - 1]
        ?.querySelector<HTMLElement>(
          'button:not(:disabled), input:not([type="hidden"]):not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        )
        ?.focus();
      setPendingRuleFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [filterCount, pendingRuleFocus, sorts.length]);

  // --- Tree edits: each rebuilds the group at `path` immutably, then persists. ---

  function addFilterAt(path: number[]) {
    const prop = queryableProps[0];
    if (!prop) return;
    const leaf: ViewFilter = {
      propertyId: prop.id,
      operator: defaultOperator(prop),
      value: defaultValue(prop),
    };
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({ ...g, filters: [...g.filters, leaf] }))
    );
    setPendingRuleFocus("filter");
  }

  function addGroupAt(path: number[]) {
    const prop = queryableProps[0];
    const newGroup: FilterGroup = {
      conjunction: "and",
      filters: prop
        ? [{ propertyId: prop.id, operator: defaultOperator(prop), value: defaultValue(prop) }]
        : [],
      groups: [],
    };
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        groups: [...(g.groups ?? []), newGroup],
      }))
    );
    setPendingRuleFocus("filter");
  }

  function setConjunctionAt(path: number[], next: "and" | "or") {
    setFilterTree(updateGroupAtPath(filterTree, path, (g) => ({ ...g, conjunction: next })));
  }

  function updateFilterAt(path: number[], index: number, patch: Partial<ViewFilter>) {
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        filters: g.filters.map((filter, i) => {
          if (i !== index) return filter;
          const merged = { ...filter, ...patch };
          if (NO_VALUE_FILTERS.has(merged.operator)) {
            return { propertyId: merged.propertyId, operator: merged.operator };
          }
          return merged;
        }),
      }))
    );
  }

  function removeFilterAt(path: number[], index: number) {
    setFilterTree(
      updateGroupAtPath(filterTree, path, (g) => ({
        ...g,
        filters: g.filters.filter((_, i) => i !== index),
      }))
    );
  }

  function removeGroupAt(parentPath: number[], index: number) {
    setFilterTree(
      updateGroupAtPath(filterTree, parentPath, (g) => ({
        ...g,
        groups: (g.groups ?? []).filter((_, i) => i !== index),
      }))
    );
  }

  function clearFilters() {
    if (readOnly || !hasFilterTerms) return;
    const previousFilterGroup = cloneViewConfigPart(filterTree);
    updateView(view.id, {
      config: {
        ...view.config,
        filterGroup: undefined,
        filters: undefined,
        filterConjunction: undefined,
        quickFilters: undefined,
      },
    });
    setPendingRuleFocus(null);
    notify(databaseViewLabels().toast.clearedFilters, "success", {
      label: databaseViewLabels().undo,
      onClick: () => {
        const currentView = useStore.getState().dbViews(dbId).find((item) => item.id === view.id);
        updateView(view.id, {
          config: {
            ...(currentView?.config ?? {}),
            filterGroup: previousFilterGroup,
            filters: undefined,
            filterConjunction: undefined,
            quickFilters: undefined,
          },
        });
        notify(databaseViewLabels().toast.restoredFilters, "success");
      },
    });
  }

  function addSort() {
    const prop = queryableProps[0];
    if (!prop) return;
    setSorts([...sorts, { propertyId: prop.id, direction: "asc" }]);
    setPendingRuleFocus("sort");
  }

  function moveSort(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sorts.length) return;
    const next = sorts.slice();
    [next[index], next[target]] = [next[target], next[index]];
    setSorts(next);
  }

  function clearSorts() {
    if (readOnly || sorts.length === 0) return;
    const previousSorts = cloneViewConfigPart(sorts);
    setSorts([]);
    setPendingRuleFocus(null);
    notify(sorts.length === 1 ? databaseViewLabels().toast.clearedSort : databaseViewLabels().toast.clearedSorts, "success", {
      label: databaseViewLabels().undo,
      onClick: () => {
        const currentView = useStore.getState().dbViews(dbId).find((item) => item.id === view.id);
        updateView(view.id, {
          config: {
            ...(currentView?.config ?? {}),
            sorts: previousSorts,
          },
        });
        notify(sorts.length === 1 ? databaseViewLabels().toast.restoredSort : databaseViewLabels().toast.restoredSorts, "success");
      },
    });
  }

  function setVisibleProperty(id: string, visible: boolean) {
    if (readOnly) return;
    const allIds = props.map((p) => p.id);
    const titleId = props.find((p) => p.type === "title")?.id;
    const current = new Set(view.config?.visibleProperties ?? allIds);
    if (visible) current.add(id);
    else current.delete(id);
    if (titleId) current.add(titleId);
    updateView(view.id, {
      config: {
        ...view.config,
        visibleProperties: allIds.filter((propId) => current.has(propId)),
      },
    });
  }

  function setAllPropertiesVisible(visible: boolean) {
    if (readOnly) return;
    const allIds = props.map((p) => p.id);
    updateView(view.id, {
      config: {
        ...view.config,
        visibleProperties: visible ? allIds : allIds.filter((id) => id === titlePropertyId),
      },
    });
  }

  function persistPropertyOrder(ids: string[]) {
    const visibleSet = view.config?.visibleProperties ? new Set(view.config.visibleProperties) : null;
    const nextVisibleProperties = visibleSet ? ids.filter((id) => visibleSet.has(id)) : undefined;
    updateView(view.id, {
      config: {
        ...view.config,
        propertyOrder: ids,
        ...(nextVisibleProperties ? { visibleProperties: nextVisibleProperties } : {}),
      },
    });
  }

  function beginPropertyDrag(prop: DbProperty, e: ReactDragEvent<HTMLElement>) {
    if (readOnly) {
      e.preventDefault();
      return;
    }
    setDraggingPropertyId(prop.id);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(TOOLBAR_PROPERTY_DRAG, prop.id);
  }

  function updatePropertyDragTarget(prop: DbProperty, e: ReactDragEvent<HTMLElement>) {
    if (readOnly) return;
    if (!draggingPropertyId && !Array.from(e.dataTransfer.types).includes(TOOLBAR_PROPERTY_DRAG)) return;
    const sourceId = e.dataTransfer.getData(TOOLBAR_PROPERTY_DRAG) || draggingPropertyId;
    if (!sourceId || sourceId === prop.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = e.currentTarget.getBoundingClientRect();
    const side = e.clientY > rect.top + rect.height / 2 ? "after" : "before";
    setDragOverPropertyId(prop.id);
    setDragOverPropertySide(side);
  }

  function clearPropertyDragState() {
    setDraggingPropertyId(null);
    setDragOverPropertyId(null);
    setDragOverPropertySide("before");
  }

  function reorderPropertyFromMenu(sourceId: string, targetId: string, side: "before" | "after") {
    if (readOnly || !sourceId || sourceId === targetId) {
      clearPropertyDragState();
      return;
    }
    const ids = orderedProps.map((prop) => prop.id);
    const sourceIndex = ids.indexOf(sourceId);
    if (sourceIndex < 0) {
      clearPropertyDragState();
      return;
    }
    const [source] = ids.splice(sourceIndex, 1);
    const targetIndex = ids.indexOf(targetId);
    if (targetIndex < 0) {
      clearPropertyDragState();
      return;
    }
    const insertAt = targetIndex + (side === "after" ? 1 : 0);
    ids.splice(insertAt, 0, source);
    persistPropertyOrder(ids);
    clearPropertyDragState();
  }

  async function createGroupProperty(type: Extract<PropertyType, "select" | "status">) {
    if (readOnly) return;
    const prop = await addProperty(
      dbId,
      type,
      type === "status"
        ? databaseViewLabels().defaultPropertyNames.status
        : databaseViewLabels().defaultPropertyNames.select,
      {
        options:
          type === "status"
            ? [
                { id: "todo", name: databaseViewLabels().defaultStatusOptions.notStarted, color: "gray" },
                { id: "doing", name: databaseViewLabels().defaultStatusOptions.inProgress, color: "blue" },
                { id: "done", name: databaseViewLabels().defaultStatusOptions.done, color: "green" },
              ]
            : [
                { id: "option-1", name: databaseViewLabels().defaultStatusOptions.option1, color: "gray" },
                { id: "option-2", name: databaseViewLabels().defaultStatusOptions.option2, color: "blue" },
              ],
      }
    );
    if (!prop) return;
    updateConfig({ groupBy: prop.id });
  }

  async function createDateViewProperty(target: "calendar" | "timeline-start" | "timeline-end") {
    if (readOnly) return;
    const prop = await addProperty(
      dbId,
      "date",
      target === "timeline-end"
        ? databaseViewLabels().defaultPropertyNames.endDate
        : databaseViewLabels().defaultPropertyNames.date
    );
    if (!prop) return;
    if (target === "calendar") updateConfig({ calendarBy: prop.id });
    else if (target === "timeline-end") updateConfig({ timelineEndBy: prop.id });
    else updateConfig({ timelineBy: prop.id });
  }

  function sourcePropertyTypeLabel(type: PropertyType) {
    return localizedPropertyTypeLabel(type);
  }

  const sourcePropertyCreateTypes = CREATABLE_PROPERTY_TYPES.filter((item) => item.type !== "title").sort((a, b) => {
    const order: PropertyType[] = [
      "rich_text",
      "number",
      "select",
      "multi_select",
      "status",
      "date",
      "person",
      "files",
      "checkbox",
      "url",
      "email",
      "phone",
      "formula",
      "relation",
      "rollup",
      "created_time",
      "created_by",
      "last_edited_time",
      "last_edited_by",
      "unique_id",
    ];
    return order.indexOf(a.type) - order.indexOf(b.type);
  });

  async function createSourceProperty(type: PropertyType) {
    if (readOnly) return;
    try {
      const prop = await addProperty(
        dbId,
        type,
        sourcePropertyTypeLabel(type),
        configForType(type, undefined, dbId)
      );
      if (!prop) {
        notify(databaseViewLabels().createPropertyFailed, "error");
        return;
      }
      setSourcePropertyCreateOpen(false);
      setSourcePropertyDetailId(prop.id);
      notify(databaseViewLabels().createdProperty(prop.name), "success");
    } catch {
      notify(databaseViewLabels().createPropertyFailed, "error");
    }
  }

  function editableSourcePropertyTypes(prop: DbProperty) {
    const systemTypes = new Set<PropertyType>([
      "created_time",
      "last_edited_time",
      "created_by",
      "last_edited_by",
    ]);
    return PROPERTY_TYPES.filter(
      (type) => type.type === prop.type || !systemTypes.has(type.type)
    ).map((type) => ({
      value: type.type,
      label: localizedPropertyTypeLabel(type.type),
      icon: <PropertyTypeIcon type={type.type} size={14} />,
    }));
  }

  async function deleteSourcePropertyWithFeedback(prop: DbProperty) {
    if (prop.type === "title") return;
    if (!window.confirm(databaseViewLabels().confirmDeleteProperty(prop.name))) return;
    try {
      const deleted = await deleteProperty(prop.id);
      if (!deleted) {
        notify(databaseViewLabels().deletePropertyFailed, "error");
        return;
      }
      setSourcePropertyDetailId(null);
      notify(databaseViewLabels().deletedProperty, "success");
    } catch {
      notify(databaseViewLabels().deletePropertyFailed, "error");
    }
  }

  async function createRowFromTemplate(templateId?: string): Promise<boolean> {
    if (readOnly) return false;
    const selectedTemplate = templateId === ""
      ? undefined
      : templateId
        ? templates.find((template) => template.id === templateId)
        : templates.find((template) => template.isDefault);
    if (
      selectedTemplate &&
      hasDatabaseTemplateStoredFileReference(selectedTemplate, props)
    ) {
      notify(databaseViewLabels().toast.storedFileTemplateApplyBlocked, "error");
      return false;
    }
    try {
      const row = await addRow(dbId, true, templateId, { focusTitle: true });
      applyViewFilterSeeds(
        row.id,
        viewFilterSeedValues(props, view, [], { currentPageId: contextPageId }),
        updatePage,
        setRowProperty
      );
      setOpen(null);
      onOpenRow?.(row.id);
      return true;
    } catch {
      notify(databaseViewLabels().toast.couldntCreateRowFromTemplate, "error");
      return false;
    }
  }

  async function createTemplate() {
    if (readOnly) return;
    try {
      const template = await addTemplate(dbId);
      if (!template) {
        notify(databaseViewLabels().toast.couldntCreateTemplate, "error");
        return;
      }
      rememberTemplateEditorReturnFocus();
      setOpen(null);
      setEditingTemplateId(template.id);
      notify(databaseViewLabels().toast.createdTemplate, "success");
    } catch {
      notify(databaseViewLabels().toast.couldntCreateTemplate, "error");
    }
  }

  async function duplicateAndEditTemplate(
    templateId: string,
    beforeHandoff?: () => void
  ): Promise<boolean> {
    if (readOnly) return false;
    const source = templates.find((template) => template.id === templateId);
    if (source && hasDatabaseTemplateStoredFileReference(source, props)) {
      notify(databaseViewLabels().toast.storedFileTemplateDuplicateBlocked, "error");
      return false;
    }
    try {
      const template = await duplicateTemplate(templateId);
      if (!template) {
        notify(databaseViewLabels().toast.couldntDuplicateTemplate, "error");
        return false;
      }
      if (!editingTemplateId) rememberTemplateEditorReturnFocus();
      setOpen(null);
      // Stop the current dialog's focus restoration only after duplication has
      // succeeded and immediately before the dialog-to-dialog handoff.
      beforeHandoff?.();
      setEditingTemplateId(template.id);
      notify(databaseViewLabels().toast.duplicatedTemplate, "success");
      return true;
    } catch {
      notify(databaseViewLabels().toast.couldntDuplicateTemplate, "error");
      return false;
    }
  }

  function rememberTemplateEditorReturnFocus() {
    const target =
      activeToolbarButtonRef.current ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (target?.isConnected) templateEditorReturnFocusRef.current = target;
  }

  async function toggleTemplateDefault(template: DbTemplate) {
    if (readOnly) return;
    const nextDefault = !template.isDefault;
    const updated = await updateTemplate(template.id, { isDefault: nextDefault });
    notify(
      updated
        ? nextDefault
          ? databaseViewLabels().toast.setDefaultTemplate
          : databaseViewLabels().toast.defaultTemplateRemoved
        : databaseViewLabels().toast.couldntUpdateTemplate,
      updated ? "success" : "error"
    );
  }

  async function deleteTemplateWithFeedback(template: DbTemplate) {
    if (readOnly) return;
    try {
      const snapshot = await deleteTemplate(template.id);
      if (!snapshot) {
        notify(databaseViewLabels().toast.couldntDeleteTemplate, "error");
        return;
      }
      notify(databaseViewLabels().toast.deletedTemplate, "success", {
        label: databaseViewLabels().undo,
        onClick: async () => {
          const restored = await restoreDeletedTemplate(snapshot);
          notify(restored ? databaseViewLabels().toast.restoredTemplate : databaseViewLabels().toast.couldntRestoreTemplate, restored ? "success" : "error");
        },
      });
    } catch {
      notify(databaseViewLabels().toast.couldntDeleteTemplate, "error");
    }
  }

  function renderPropertyRow(prop: DbProperty) {
    const isTitle = prop.type === "title";
    const visible = isTitle || visibleIds.has(prop.id);
    return (
      <div
        key={prop.id}
        className={styles.propertyRuleRow}
        data-property-row={prop.id}
        data-property-title={isTitle ? "true" : undefined}
        data-property-dragging={draggingPropertyId === prop.id ? "true" : undefined}
        data-property-drag-over={dragOverPropertyId === prop.id ? "true" : undefined}
        data-drop-side={dragOverPropertyId === prop.id ? dragOverPropertySide : undefined}
        tabIndex={-1}
        onDragOver={(e) => updatePropertyDragTarget(prop, e)}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragOverPropertyId((current) => (current === prop.id ? null : current));
        }}
        onDrop={(e) => {
          if (readOnly) return;
          e.preventDefault();
          reorderPropertyFromMenu(
            e.dataTransfer.getData(TOOLBAR_PROPERTY_DRAG) || draggingPropertyId || "",
            prop.id,
            dragOverPropertySide
          );
        }}
        onDragEnd={clearPropertyDragState}
      >
        <button
          type="button"
          className={styles.propertyDragHandle}
          draggable={!readOnly}
          disabled={readOnly}
          data-property-drag-handle="true"
          aria-label={databaseViewLabels().dragProperty(prop.name)}
          onDragStart={(e) => beginPropertyDrag(prop, e)}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <DragHandleIcon size={14} aria-hidden="true" />
        </button>
        <div className={styles.propertyVisibilityMain}>
          <span className={styles.propertyVisibilityIcon}>
            <PropertyTypeIcon type={prop.type} size={18} />
          </span>
          <span className={styles.propertyName}>{prop.name}</span>
        </div>
        <button
          type="button"
          className={styles.propertyVisibilityToggle}
          disabled={isTitle}
          data-property-visible={visible ? "true" : "false"}
          aria-label={
            visible
              ? databaseViewLabels().hideProperty(prop.name)
              : databaseViewLabels().showProperty(prop.name)
          }
          onClick={() => setVisibleProperty(prop.id, !visible)}
        >
          {visible ? <EyeIcon size={18} /> : <EyeSlashIcon size={18} />}
        </button>
      </div>
    );
  }

  function renderSourcePropertyEditorRow(prop: DbProperty) {
    return (
      <button
        key={prop.id}
        type="button"
        className={styles.sourcePropertyEditRow}
        data-source-property-row={prop.id}
        onClick={() => setSourcePropertyDetailId(prop.id)}
      >
        <span className={styles.sourcePropertyIcon}>
          <PropertyTypeIcon type={prop.type} size={20} />
        </span>
        <span className={styles.sourcePropertyName}>{prop.name}</span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div
      ref={toolbarRootRef}
      className={styles.dbToolbar}
      role="toolbar"
      aria-label={databaseViewLabels().databaseToolbar}
      data-database-toolbar={dbId}
      tabIndex={-1}
      data-compact-imported-inline={compactImportedInline ? "true" : undefined}
    >
      <div className={styles.dbToolbarGroup}>
        {(showLayoutOptions || open === "layout") && (
          <div className={styles.toolbarPopoverWrap}>
            {showLayoutOptions && (
              <button
                type="button"
                className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
                data-active={layoutActive ? "true" : undefined}
                aria-label={databaseViewLabels().layout}
                aria-haspopup="dialog"
                aria-expanded={open === "layout"}
                disabled={readOnly}
                title={databaseViewLabels().layout}
                onClick={(e) => toggleMenu("layout", e.currentTarget)}
              >
                <LayoutIcon size={14} aria-hidden="true" />
                <span className={styles.toolbarLabel}>{databaseViewLabels().layout}</span>
              </button>
            )}
            {open === "layout" &&
              renderToolbarMenuLayer(
              <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label={databaseViewLabels().closeLayoutOptions}
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.layoutMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label={databaseViewLabels().layoutOptions}
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().layout}</div>
                  <div
                    className={styles.layoutTypeGrid}
                    role="radiogroup"
                    tabIndex={-1}
                    aria-label={databaseViewLabels().databaseViewType}
                    onKeyDown={onSegmentedOptionGroupKeyDown}
                  >
                    {NOTION_2023_VIEW_TYPES.map((typeOption) => (
                      <button
                        key={typeOption.type}
                        type="button"
                        className={styles.layoutTypeButton}
                        data-segmented-option
                        data-active={view.type === typeOption.type ? "true" : undefined}
                        role="radio"
                        aria-checked={view.type === typeOption.type}
                        tabIndex={view.type === typeOption.type ? 0 : -1}
                        onClick={() => updateViewType(typeOption.type)}
                      >
                        <span className={styles.viewGlyph}>
                          <ViewTypeIcon type={typeOption.type} />
                        </span>
                        <span>{viewTypeSettingsLabel(typeOption.type)}</span>
                        {view.type === typeOption.type && (
                          <span className={styles.check}>
                            <CheckIcon size={14} />
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.layoutRow}>
                    <span>{databaseViewLabels().openPagesIn}</span>
                    <div
                      className={styles.segmented}
                      role="radiogroup"
                      tabIndex={-1}
                      aria-label={databaseViewLabels().openDatabasePagesIn}
                      onKeyDown={onSegmentedOptionGroupKeyDown}
                    >
                      {(["side", "center", "full"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          data-segmented-option
                          data-active={openPageIn === m ? "true" : undefined}
                          role="radio"
                          aria-checked={openPageIn === m}
                          tabIndex={openPageIn === m ? 0 : -1}
                          onClick={() => updateConfig({ openPageIn: m })}
                        >
                          {m === "side"
                            ? databaseViewLabels().side
                            : m === "center"
                              ? databaseViewLabels().center
                              : databaseViewLabels().full}
                        </button>
                      ))}
                    </div>
                  </div>
                  {subitemViewSettingsVisible && (
                    <>
                      <div className={styles.layoutSectionDivider} />
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().subitemsDisplay}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().subitemsDisplay}
                          value={subitemDisplayMode}
                          options={subitemDisplayOptions}
                          onChange={(value) =>
                            updateSubitemViewConfig({
                              displayMode: value === "flattened" ? "flattened" : "show",
                            })
                          }
                        />
                      </label>
                      {isRowSubitemView ? (
                        <label className={styles.layoutRow}>
                          <span>{databaseViewLabels().subitemFilter}</span>
                          <NotionSelect
                            ariaLabel={databaseViewLabels().subitemFilter}
                            value={subitemFilterScope}
                            options={[
                              { value: "parents", label: databaseViewLabels().parentsOnly },
                              {
                                value: "parents_and_subitems",
                                label: databaseViewLabels().parentsAndSubitems,
                              },
                              { value: "subitems", label: databaseViewLabels().subitemsOnly },
                            ]}
                            onChange={(value) =>
                              updateSubitemViewConfig({
                                filterScope: value as DatabaseSubtaskViewConfig["filterScope"],
                              })
                            }
                          />
                        </label>
                      ) : (
                        <div className={styles.layoutRow}>
                          <span>{databaseViewLabels().subitemFilter}</span>
                          <span
                            className={styles.layoutStaticValue}
                            data-subitem-filter-fixed
                          >
                            {databaseViewLabels().parentsOnly}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {view.type === "table" && (
                    <>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().rowHeight}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().tableRowHeight}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["short", "medium", "tall"] as const).map((h) => (
                            <button
                              key={h}
                              type="button"
                              data-segmented-option
                              data-active={rowHeight === h ? "true" : undefined}
                              role="radio"
                              aria-checked={rowHeight === h}
                              tabIndex={rowHeight === h ? 0 : -1}
                              onClick={() => updateConfig({ rowHeight: h })}
                            >
                              {h === "short"
                                ? databaseViewLabels().short
                                : h === "medium"
                                  ? databaseViewLabels().medium
                                  : databaseViewLabels().tall}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().initialLoad}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().initialLoad}
                          value={String(initialLoadLimit)}
                          options={TABLE_INITIAL_LOAD_OPTIONS.map((limit) => ({
                            value: String(limit),
                            label: String(limit),
                          }))}
                          onChange={(value) => updateConfig({ initialLoadLimit: Number(value) })}
                        />
                      </label>
                    </>
                  )}
                  {isCardView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().cardPreview}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().cardPreview}
                          value={cardPreviewValue}
                          options={coverPropertyOptions}
                          onChange={(value) =>
                            updateConfig({
                              coverProperty:
                                value === CARD_PREVIEW_PAGE && !isBoardView ? undefined : value,
                            })
                          }
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().cardSize}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().cardSize}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["small", "medium", "large"] as const).map((size) => (
                            <button
                              key={size}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.cardSize ?? "medium") === size ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.cardSize ?? "medium") === size}
                              tabIndex={(view.config?.cardSize ?? "medium") === size ? 0 : -1}
                              onClick={() => updateConfig({ cardSize: size })}
                            >
                              {size === "small"
                                ? databaseViewLabels().small
                                : size === "medium"
                                  ? databaseViewLabels().medium
                                  : databaseViewLabels().large}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.fitImage}
                          onChange={(e) => updateConfig({ fitImage: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().fitImage}
                      </label>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.wrap}
                          onChange={(e) => updateConfig({ wrap: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().wrapProperties}
                      </label>
                    </>
                  )}

                  {isCalendarView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().calendarBy}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().calendarBy}
                          value={view.config?.calendarBy ?? dateProps[0]?.id ?? ""}
                          options={datePropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ calendarBy: value || undefined })}
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().calendarView}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().calendarView}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["month", "week"] as const).map((layout) => (
                            <button
                              key={layout}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.calendarLayout ?? "month") === layout ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.calendarLayout ?? "month") === layout}
                              tabIndex={(view.config?.calendarLayout ?? "month") === layout ? 0 : -1}
                              onClick={() => updateConfig({ calendarLayout: layout === "month" ? undefined : layout })}
                            >
                              {layout === "month" ? databaseViewLabels().month : databaseViewLabels().week}
                            </button>
                          ))}
                        </div>
                      </div>
                      {dateProps.length === 0 && (
                        <div className={styles.layoutActions}>
                          <button type="button" onClick={() => void createDateViewProperty("calendar")}>
                            <Plus size={14} /> {databaseViewLabels().addDateProperty}
                          </button>
                        </div>
                      )}
                    </>
                  )}

                  {isTimelineView && (
                    <>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().timelineBy}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().timelineBy}
                          value={view.config?.timelineBy ?? view.config?.calendarBy ?? dateProps[0]?.id ?? ""}
                          options={datePropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ timelineBy: value || undefined })}
                        />
                      </label>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().timelineEndDate}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().timelineEndDate}
                          value={view.config?.timelineEndBy ?? ""}
                          options={timelineEndPropertyOptions}
                          disabled={dateProps.length === 0}
                          onChange={(value) => updateConfig({ timelineEndBy: value || undefined })}
                        />
                      </label>
                      <div className={styles.layoutRow}>
                        <span>{databaseViewLabels().timeUnit}</span>
                        <div
                          className={styles.segmented}
                          role="radiogroup"
                          tabIndex={-1}
                          aria-label={databaseViewLabels().timelineZoomAria}
                          onKeyDown={onSegmentedOptionGroupKeyDown}
                        >
                          {(["day", "week", "month"] as const).map((zoom) => (
                            <button
                              key={zoom}
                              type="button"
                              data-segmented-option
                              data-active={(view.config?.timelineZoom ?? "day") === zoom ? "true" : undefined}
                              role="radio"
                              aria-checked={(view.config?.timelineZoom ?? "day") === zoom}
                              tabIndex={(view.config?.timelineZoom ?? "day") === zoom ? 0 : -1}
                              onClick={() => updateConfig({ timelineZoom: zoom === "day" ? undefined : zoom })}
                            >
                              {zoom === "day"
                                ? databaseViewLabels().day
                                : zoom === "week"
                                  ? databaseViewLabels().week
                                  : databaseViewLabels().month}
                            </button>
                          ))}
                        </div>
                      </div>
                      <label className={styles.layoutRow}>
                        <span>{databaseViewLabels().loadLimit}</span>
                        <NotionSelect
                          ariaLabel={databaseViewLabels().loadLimit}
                          value={String(timelineLimit)}
                          options={TIMELINE_LOAD_LIMIT_OPTIONS.map((limit) => ({
                            value: String(limit),
                            label: String(limit),
                          }))}
                          onChange={(value) => updateConfig({ timelineLoadLimit: Number(value) })}
                        />
                      </label>
                      <label className={styles.layoutToggle}>
                        <input
                          type="checkbox"
                          checked={!!view.config?.timelineShowTable}
                          onChange={(e) => updateConfig({ timelineShowTable: e.target.checked || undefined })}
                        />
                        {databaseViewLabels().showTable}
                      </label>
                      <div className={styles.layoutActions}>
                        {dateProps.length === 0 && (
                          <button type="button" onClick={() => void createDateViewProperty("timeline-start")}>
                            <Plus size={14} /> {databaseViewLabels().addDateProperty}
                          </button>
                        )}
                        {dateProps.length > 0 && (
                          <button type="button" onClick={() => void createDateViewProperty("timeline-end")}>
                            <Plus size={14} /> {databaseViewLabels().addEndDateProperty}
                          </button>
                        )}
                      </div>
                    </>
                  )}

                </div>
              </>
              )}
          </div>
        )}

        {isBoardView && (
          <div className={styles.toolbarPopoverWrap}>
            <button
              type="button"
              className={`${styles.toolbarBtn} ${compactImportedInline ? styles.iconToolbarBtn : ""}`}
              data-active={activeGroupProp ? "true" : undefined}
              aria-label={`${databaseViewLabels().group}${activeGroupProp ? `: ${activeGroupProp.name}` : ""}`}
              aria-haspopup="dialog"
              aria-expanded={open === "group"}
              disabled={readOnly}
              title={`${databaseViewLabels().group}${activeGroupProp ? `: ${activeGroupProp.name}` : ""}`}
              onClick={(e) => toggleMenu("group", e.currentTarget)}
            >
              {compactImportedInline ? (
                <>
                  <PropertyTypeIcon type={activeGroupProp?.type ?? "status"} size={14} />
                  <span className={styles.toolbarLabel}>
                    {databaseViewLabels().group}{activeGroupProp ? `: ${activeGroupProp.name}` : ""}
                  </span>
                </>
              ) : (
                <>{databaseViewLabels().group}{activeGroupProp ? `: ${activeGroupProp.name}` : ""}</>
              )}
            </button>
            {open === "group" &&
              renderToolbarMenuLayer(
                <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label={databaseViewLabels().closeGroupOptions}
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.groupMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label={databaseViewLabels().groupBy}
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().groupBy}</div>
                  {groupProps.length > 0 ? (
                    <div className={styles.groupList}>
                      {groupProps.map((prop) => (
                        <button
                          key={prop.id}
                          type="button"
                          className={styles.groupItem}
                          data-active={activeGroupProp?.id === prop.id ? "true" : undefined}
                          onClick={() => updateConfig({ groupBy: prop.id })}
                        >
                          <span className={styles.groupGlyph}>
                            <PropertyTypeIcon type={prop.type} size={14} />
                          </span>
                          <span>{prop.name}</span>
                          {activeGroupProp?.id === prop.id && (
                            <span className={styles.check}>
                              <CheckIcon size={14} />
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className={styles.toolbarEmpty}>{databaseViewLabels().groupEmpty}</div>
                  )}
                  <div className={styles.groupActions}>
                    <button type="button" onClick={() => void createGroupProperty("status")}>
                      <Plus size={14} /> {databaseViewLabels().addStatusProperty}
                    </button>
                    <button type="button" onClick={() => void createGroupProperty("select")}>
                      <Plus size={14} /> {databaseViewLabels().addSelectProperty}
                    </button>
                  </div>
                </div>
                </>
              )}
          </div>
        )}

        {(showDirectProperties || open === "properties" || open === "sourceProperties") && (
        <div className={styles.toolbarPopoverWrap}>
          {showDirectProperties && (
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              data-active={hiddenCount > 0 ? "true" : undefined}
              aria-label={databaseViewLabels().properties}
              aria-haspopup="dialog"
              aria-expanded={open === "properties"}
              disabled={readOnly}
              title={databaseViewLabels().properties}
              onClick={(e) => toggleMenu("properties", e.currentTarget)}
            >
              <PropertiesIcon size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>{databaseViewLabels().properties}</span>
            </button>
          )}
          {open === "properties" &&
            renderToolbarMenuLayer(
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label={databaseViewLabels().closePropertiesMenu}
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.propertiesMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().propertyVisibility}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.propertiesVisibilityHead}>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityBack}
                    aria-label={
                      propertiesReturnMenu
                        ? databaseViewLabels().backToViewSettings
                        : databaseViewLabels().closePropertyVisibility
                    }
                    onClick={goBackFromPropertiesMenu}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                  </button>
                  <div className={styles.propertiesVisibilityTitle}>{databaseViewLabels().propertyVisibility}</div>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityClose}
                    aria-label={databaseViewLabels().closePropertyVisibility}
                    onClick={() => closeToolbarMenu(true)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                <div className={styles.propertiesSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    type="text"
                    value={propertySearch}
                    placeholder={databaseViewLabels().searchProperties}
                    aria-label={databaseViewLabels().searchProperties}
                    onChange={(e) => setPropertySearch(e.target.value)}
                  />
                </div>
                <div className={styles.propertiesList}>
                  {visibleFilteredProps.length > 0 && (
                    <div className={styles.propertiesSection}>
                      <div className={styles.propertiesSectionHead}>
                        <span>{databaseViewLabels().shownInTable}</span>
                        <button
                          type="button"
                          disabled={!visibleFilteredProps.some((prop) => prop.type !== "title")}
                          onClick={() => setAllPropertiesVisible(false)}
                        >
                          {databaseViewLabels().hideAll}
                        </button>
                      </div>
                      {visibleFilteredProps.map(renderPropertyRow)}
                    </div>
                  )}
                  {hiddenFilteredProps.length > 0 && (
                    <div className={styles.propertiesSection}>
                      <div className={styles.propertiesSectionHead}>
                        <span>{databaseViewLabels().hiddenInTable}</span>
                        <button type="button" onClick={() => setAllPropertiesVisible(true)}>
                          {databaseViewLabels().showAll}
                        </button>
                      </div>
                      {hiddenFilteredProps.map(renderPropertyRow)}
                    </div>
                  )}
                  {filteredOrderedProps.length === 0 && (
                    <div className={styles.propertiesEmpty}>{databaseViewLabels().noSearchResults}</div>
                  )}
                </div>
              </div>
              </>
            )}
          {open === "sourceProperties" &&
            renderToolbarMenuLayer(
            <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label={databaseViewLabels().closeSourcePropertiesMenu}
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.propertiesMenu} ${styles.sourcePropertiesMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().properties}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.propertiesVisibilityHead}>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityBack}
                    aria-label={
                      sourcePropertyDetail
                        ? databaseViewLabels().backToPropertyList
                        : sourcePropertyCreateOpen
                          ? databaseViewLabels().backToProperties
                        : propertiesReturnMenu
                          ? databaseViewLabels().backToViewSettings
                          : databaseViewLabels().closeProperties
                    }
                    onClick={goBackFromPropertiesMenu}
                  >
                    <ArrowLeft size={18} aria-hidden="true" />
                  </button>
                  <div className={styles.propertiesVisibilityTitle}>
                    {sourcePropertyDetail
                      ? sourcePropertyDetail.name
                      : sourcePropertyCreateOpen
                        ? databaseViewLabels().newPropertyIn(databaseDisplayTitle(pagesById[dbId]))
                        : databaseViewLabels().properties}
                  </div>
                  <button
                    type="button"
                    className={styles.propertiesVisibilityClose}
                    aria-label={databaseViewLabels().closeProperties}
                    onClick={() => closeToolbarMenu(true)}
                  >
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
                {sourcePropertyDetail ? (
                  <div className={styles.sourcePropertyDetail}>
                    <label className={styles.propertyHeaderField}>
                      <span>{databaseViewLabels().name}</span>
                        <input
                          value={sourcePropertyDetail.name}
                          autoFocus
                          onChange={(e) => updateProperty(sourcePropertyDetail.id, { name: e.target.value })}
                          onKeyDown={(e) => {
                            if (isComposingKeyEvent(e)) return;
                            if (e.key !== "Escape" && e.key !== "Enter") return;
                            e.preventDefault();
                            setSourcePropertyDetailId(null);
                          }}
                        />
                    </label>
                    <div className={styles.propertyHeaderField}>
                      <span>{databaseViewLabels().type}</span>
                      <NotionSelect
                        ariaLabel={databaseViewLabels().propertyType}
                        value={sourcePropertyDetail.type}
                        disabled={sourcePropertyDetail.type === "title"}
                        options={editableSourcePropertyTypes(sourcePropertyDetail)}
                        onChange={(value) => {
                          const type = value as PropertyType;
                          confirmPropertyTypeChange(sourcePropertyDetail, type, () => {
                            updateProperty(sourcePropertyDetail.id, {
                              type,
                              config: configForType(type, sourcePropertyDetail.config, dbId),
                            });
                          });
                        }}
                      />
                    </div>
                    <label className={styles.propertyHeaderField}>
                      <span>{databaseViewLabels().description}</span>
                      <textarea
                        value={sourcePropertyDetail.description ?? ""}
                        placeholder={databaseViewLabels().addDescription}
                        rows={2}
                        onChange={(e) =>
                          updateProperty(sourcePropertyDetail.id, {
                            description: e.target.value || undefined,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key !== "Escape") return;
                          e.preventDefault();
                          setSourcePropertyDetailId(null);
                        }}
                      />
                    </label>
                    <PropertyTypeConfig prop={sourcePropertyDetail} onClose={() => setSourcePropertyDetailId(null)} />
                    <div className={styles.propertyHeaderDivider} />
                    <button
                      type="button"
                      className={`${styles.propertyHeaderItem} ${styles.propertyDanger}`}
                      disabled={sourcePropertyDetail.type === "title"}
                      onClick={() => void deleteSourcePropertyWithFeedback(sourcePropertyDetail)}
                    >
                      {databaseViewLabels().deleteProperty}
                    </button>
                  </div>
                ) : sourcePropertyCreateOpen ? (
                  <div className={styles.sourcePropertyTypePicker}>
                    <div className={styles.sourcePropertyTypeHeader}>
                      <span>{databaseViewLabels().type}</span>
                      <Search size={20} aria-hidden="true" />
                    </div>
                    <div className={styles.sourcePropertyTypeList}>
                      {sourcePropertyCreateTypes.map((item) => (
                        <button
                          key={item.type}
                          type="button"
                          className={styles.sourcePropertyTypeRow}
                          data-source-property-type={item.type}
                          onClick={() => void createSourceProperty(item.type)}
                        >
                          <span className={styles.sourcePropertyIcon}>
                            <PropertyTypeIcon type={item.type} size={22} />
                          </span>
                          <span>{sourcePropertyTypeLabel(item.type)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.propertiesSearch}>
                      <Search size={14} aria-hidden="true" />
                      <input
                        type="text"
                        value={propertySearch}
                        placeholder={databaseViewLabels().searchProperties}
                        aria-label={databaseViewLabels().searchProperties}
                        onChange={(e) => setPropertySearch(e.target.value)}
                      />
                    </div>
                    <div className={styles.sourcePropertiesList}>
                      {sourcePropertyEditorProps.length === 0 ? (
                        <div className={styles.propertiesEmpty}>{databaseViewLabels().noSearchResults}</div>
                      ) : (
                        sourcePropertyEditorProps.map(renderSourcePropertyEditorRow)
                      )}
                    </div>
                    <div className={styles.sourcePropertyFooter}>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => setSourcePropertyCreateOpen(true)}
                      >
                        <Plus size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().newProperty}</span>
                      </button>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => notify(databaseViewLabels().deletedPropertiesNotLinked)}
                      >
                        <Trash size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().deletedProperties}</span>
                        <span className={styles.sourcePropertyMeta}>0</span>
                        <ChevronRight size={18} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.sourcePropertyFooterRow}
                        onClick={() => notify(databaseViewLabels().propertyHelpNotLinked)}
                      >
                        <ClockIcon size={20} aria-hidden="true" />
                        <span>{databaseViewLabels().propertyHelp}</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
              </>
            )}
        </div>
        )}

        <div className={styles.toolbarPopoverWrap}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            data-active={hasActiveFilterTerms ? "true" : undefined}
            aria-label={databaseViewLabels().filter}
            aria-haspopup="dialog"
            aria-expanded={open === "filter"}
            disabled={readOnly}
            title={databaseViewLabels().filter}
            onClick={(e) => toggleMenu("filter", e.currentTarget)}
          >
            <FilterIcon size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>{databaseViewLabels().filter}</span>
          </button>
          {open === "filter" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label={databaseViewLabels().closeFiltersMenu}
              />
              <div
                ref={toolbarMenuRef}
                className={styles.toolbarMenu}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().filters}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.toolbarMenuHead}>
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().filters}</div>
                  {hasFilterTerms && (
                    <button type="button" className={styles.toolbarMenuClear} onClick={clearFilters}>
                      {databaseViewLabels().clearAll}
                    </button>
                  )}
                </div>
                {!hasFilterTerms && (
                  <div className={styles.toolbarEmpty}>{databaseViewLabels().filtersEmpty}</div>
                )}
                <FilterGroupEditor
                  group={filterTree}
                  path={[]}
                  props={queryableProps}
                  onSetConjunction={setConjunctionAt}
                  onUpdateFilter={updateFilterAt}
                  onRemoveFilter={removeFilterAt}
                  onRemoveGroup={removeGroupAt}
                  onAddFilter={addFilterAt}
                  onAddGroup={addGroupAt}
                />
              </div>
              </>
            )}
        </div>

        <div className={styles.toolbarPopoverWrap}>
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            data-active={sorts.length > 0 ? "true" : undefined}
            aria-label={databaseViewLabels().sort}
            aria-haspopup="dialog"
            aria-expanded={open === "sort"}
            disabled={readOnly}
            title={databaseViewLabels().sort}
            onClick={(e) => toggleMenu("sort", e.currentTarget)}
          >
            <SortIcon size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>{databaseViewLabels().sort}</span>
          </button>
          {open === "sort" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label={databaseViewLabels().closeSortsMenu}
              />
              <div
                ref={toolbarMenuRef}
                className={styles.toolbarMenu}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().sorts}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <div className={styles.toolbarMenuHead}>
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().sorts}</div>
                  {sorts.length > 0 && (
                    <button type="button" className={styles.toolbarMenuClear} onClick={clearSorts}>
                      {databaseViewLabels().clearAll}
                    </button>
                  )}
                </div>
                {sorts.length === 0 && (
                  <div className={styles.toolbarEmpty}>{databaseViewLabels().sortsEmpty}</div>
                )}
                {sorts.map((sort, index) => (
                  <SortRow
                    key={`${sort.propertyId}-${index}`}
                    sort={sort}
                    props={queryableProps}
                    canMoveUp={index > 0}
                    canMoveDown={index < sorts.length - 1}
                    onMove={(dir) => moveSort(index, dir)}
                    onChange={(patch) =>
                      setSorts(sorts.map((item, i) => (i === index ? { ...item, ...patch } : item)))
                    }
                    onRemove={() => setSorts(sorts.filter((_, i) => i !== index))}
                  />
                ))}
                <button type="button" className={styles.toolbarAdd} onClick={addSort}>
                  <Plus size={14} /> {databaseViewLabels().addSort}
                </button>
              </div>
              </>
            )}
        </div>

        {searchOpen || search ? (
          <div
            className={styles.dbSearchBox}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              if (search) clearSearchNow();
              else setSearchOpen(false);
            }}
          >
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              value={search}
              aria-label={databaseViewLabels().searchDatabaseRows}
              placeholder={i18next.t("common:actions.search")}
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => {
                setOpen(null);
                setSearchOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  if (search) clearSearchNow();
                  else setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              aria-label={databaseViewLabels().closeSearch}
              onClick={() => {
                clearSearchNow();
                setSearchOpen(false);
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
            aria-label={databaseViewLabels().searchDatabaseRows}
            title={i18next.t("common:actions.search")}
            onClick={() => {
              setOpen(null);
              setSearchOpen(true);
            }}
          >
            <Search size={14} aria-hidden="true" />
            <span className={styles.toolbarLabel}>{databaseViewLabels().search}</span>
          </button>
        )}
        {compactImportedInline && (
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              aria-label={databaseViewLabels().openDatabaseAsPage}
              title={databaseViewLabels().openAsPageShort}
              onClick={() => {
                window.open(databaseViewLink(dbId, view.id), "_blank", "noopener,noreferrer");
              }}
            >
              <OpenInNew size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>{databaseViewLabels().openAsPageShort}</span>
            </button>
        )}
            <button
              type="button"
              className={`${styles.toolbarBtn} ${styles.iconToolbarBtn}`}
              aria-label={databaseViewLabels().databaseSettings}
              aria-haspopup="dialog"
              aria-expanded={open === "settings"}
              title={databaseViewLabels().settings}
              disabled={readOnly}
              onClick={(e) => toggleMenu("settings", e.currentTarget)}
            >
              <ListIcon size={14} aria-hidden="true" />
              <span className={styles.toolbarLabel}>{databaseViewLabels().settings}</span>
            </button>
            {open === "settings" &&
              renderToolbarMenuLayer(
                <>
                <button
                  type="button"
                  className={styles.menuBackdrop}
                  onClick={() => closeToolbarMenu(true)}
                  tabIndex={-1}
                  aria-label={databaseViewLabels().closeViewSettings}
                />
                <div
                  ref={toolbarMenuRef}
                  className={`${styles.toolbarMenu} ${styles.viewSettingsMenu}`}
                  style={toolbarMenuStyle}
                  role="dialog"
                  aria-label={databaseViewLabels().viewSettings}
                  onKeyDown={onToolbarMenuKeyDown}
                >
                  <div className={styles.toolbarMenuHead}>
                    <div className={styles.toolbarMenuLabel}>{databaseViewLabels().viewSettingsLabel}</div>
                    <button
                      type="button"
                      className={styles.toolbarMenuClear}
                      aria-label={databaseViewLabels().closeViewSettings}
                      onClick={() => closeToolbarMenu(true)}
                    >
                      <X size={13} aria-hidden="true" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className={styles.viewSettingsViewRow}
                    onClick={() => openRelatedToolbarMenu("layout")}
                  >
                    <span className={styles.viewGlyph}>
                      <ViewTypeIcon type={view.type} />
                    </span>
                    <span>{view.name || databaseViewLabels().defaultView}</span>
                  </button>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.viewSettingsList}>
                    <button type="button" onClick={() => openRelatedToolbarMenu("layout")}>
                      <LayoutIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().layout}</span>
                      <span>{viewTypeSettingsLabel(view.type)}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("properties")}>
                      <PropertiesIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().propertyVisibility}</span>
                      <span>{hiddenCount > 0 ? databaseViewLabels().hiddenCountSuffix(hiddenCount) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("filter")}>
                      <FilterIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().filter}</span>
                      <span>{filterCount > 0 ? databaseViewLabels().countSuffix(filterCount) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("sort")}>
                      <SortIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().sort}</span>
                      <span>{sorts.length > 0 ? databaseViewLabels().countSuffix(sorts.length) : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => (isBoardView ? openRelatedToolbarMenu("group") : undefined)}
                      disabled={!isBoardView}
                    >
                      <StatusIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().group}</span>
                      <span>{activeGroupProp && isBoardView ? activeGroupProp.name : ""}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <SelectIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().conditionalColor}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => void copyActiveViewLink()}>
                      <LinkIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().copyViewLink}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div className={styles.layoutSectionDivider} />
                  <div className={styles.toolbarMenuLabel}>{databaseViewLabels().dataSourceSettings}</div>
                  <div className={styles.viewSettingsList}>
                    <button
                      type="button"
                      onClick={() => window.open(databaseViewLink(dbId, view.id), "_blank", "noopener,noreferrer")}
                    >
                      <TableIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().database}</span>
                      <span>{databaseDisplayTitle(pagesById[dbId])}</span>
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("sourceProperties")}>
                      <PropertiesIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().editProperties}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => openRelatedToolbarMenu("automations")}>
                      <StatusIcon size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().automations}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button type="button" disabled>
                      <DotsHorizontal size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().aiAutofill}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => openRelatedToolbarMenu("additionalSettings")}
                    >
                      <Plus size={14} aria-hidden="true" />
                      <span>{databaseViewLabels().moreSettings}</span>
                      <span />
                      <ChevronRight size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                </>
              )}
            {open === "automations" && pagesById[dbId]?.workspaceId &&
              renderToolbarMenuLayer(
                <DatabaseAutomationPanel
                  databaseId={dbId}
                  workspaceId={pagesById[dbId].workspaceId}
                  properties={props}
                  views={databaseViews}
                  onClose={() => closeToolbarMenu(true)}
                />
              )}
            {open === "additionalSettings" &&
              renderToolbarMenuLayer(
                <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeToolbarMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeViewSettings}
                  />
                  <div
                    ref={toolbarMenuRef}
                    className={`${styles.toolbarMenu} ${styles.viewSettingsMenu} ${styles.taskFeatureMenu}`}
                    style={toolbarMenuStyle}
                    role="dialog"
                    aria-label={databaseViewLabels().additionalSettings}
                    onKeyDown={onToolbarMenuKeyDown}
                  >
                    <div className={styles.toolbarMenuHead}>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().backToViewSettings}
                        onClick={() => openRelatedToolbarMenu("settings")}
                      >
                        <ArrowLeft size={13} aria-hidden="true" />
                      </button>
                      <div className={styles.toolbarMenuLabel}>
                        {databaseViewLabels().additionalSettings}
                      </div>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().closeViewSettings}
                        onClick={() => closeToolbarMenu(true)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.viewSettingsList}>
                      <button
                        type="button"
                        onClick={() => openRelatedToolbarMenu("subitemsSettings")}
                      >
                        <DoubleChevronRight size={14} aria-hidden="true" />
                        <span>{databaseViewLabels().subitems}</span>
                        <span>{subitemsEnabled ? databaseViewLabels().taskFeatureOn : ""}</span>
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                      <button type="button" onClick={openDependenciesSettings}>
                        <LinkIcon size={14} aria-hidden="true" />
                        <span>{databaseViewLabels().dependencies}</span>
                        <span>{dependenciesEnabled ? databaseViewLabels().taskFeatureOn : ""}</span>
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                </>
              )}
            {open === "subitemsSettings" &&
              renderToolbarMenuLayer(
                <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeToolbarMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeViewSettings}
                  />
                  <div
                    ref={toolbarMenuRef}
                    className={`${styles.toolbarMenu} ${styles.viewSettingsMenu} ${styles.taskFeatureMenu}`}
                    style={toolbarMenuStyle}
                    role="dialog"
                    aria-label={databaseViewLabels().subitems}
                    aria-busy={subitemsActivationBusy}
                    onKeyDown={onToolbarMenuKeyDown}
                  >
                    <div className={styles.toolbarMenuHead}>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().additionalSettings}
                        onClick={() => openRelatedToolbarMenu("additionalSettings")}
                      >
                        <ArrowLeft size={13} aria-hidden="true" />
                      </button>
                      <div className={styles.toolbarMenuLabel}>{databaseViewLabels().subitems}</div>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().closeViewSettings}
                        onClick={() => closeToolbarMenu(true)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.taskFeatureBody}>
                      <p>{databaseViewLabels().subitemsDescription}</p>
                      <div className={styles.subitemsPreview} aria-hidden="true">
                        <div><ChevronDown size={13} /><span>{databaseViewLabels().parentItemPropertyName}</span></div>
                        <div><span /> <span>{databaseViewLabels().subitemPropertyName}</span></div>
                        <div><span /> <span>{databaseViewLabels().subitemPropertyName}</span></div>
                      </div>
                      {subitemsEnabled && (
                        <button
                          type="button"
                          className={styles.taskFeatureSecondary}
                          onClick={openSubitemAdvancedSettings}
                        >
                          <span>{databaseViewLabels().advancedSettings}</span>
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      )}
                      <button
                        type="button"
                        className={styles.taskFeaturePrimary}
                        disabled={subitemsActivationBusy}
                        onClick={() => {
                          if (subitemsEnabled) openTaskFeatureTurnOff("subitems");
                          else void activateSubitems();
                        }}
                      >
                        {subitemsEnabled
                          ? databaseViewLabels().turnOffSubitems
                          : databaseViewLabels().turnOnSubitems}
                      </button>
                    </div>
                  </div>
                </>
              )}
            {open === "subitemsAdvancedSettings" &&
              renderToolbarMenuLayer(
                <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeToolbarMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeViewSettings}
                  />
                  <div
                    ref={toolbarMenuRef}
                    className={`${styles.toolbarMenu} ${styles.viewSettingsMenu} ${styles.taskFeatureMenu}`}
                    style={toolbarMenuStyle}
                    role="dialog"
                    aria-label={databaseViewLabels().advancedSubitemSettings}
                    aria-busy={subitemsActivationBusy}
                    onKeyDown={onToolbarMenuKeyDown}
                  >
                    <div className={styles.toolbarMenuHead}>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().subitems}
                        onClick={() => openRelatedToolbarMenu("subitemsSettings")}
                      >
                        <ArrowLeft size={13} aria-hidden="true" />
                      </button>
                      <div className={styles.toolbarMenuLabel}>
                        {databaseViewLabels().advancedSettings}
                      </div>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().closeViewSettings}
                        onClick={() => closeToolbarMenu(true)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.taskFeatureBody}>
                      <label className={styles.taskFeatureSelect}>
                        <span>{databaseViewLabels().property}</span>
                        <select
                          aria-label={databaseViewLabels().property}
                          value={subitemNestedPropertyId}
                          onChange={(event) => setSubitemNestedPropertyId(event.currentTarget.value)}
                        >
                          <option value={subitemsBinding?.childrenPropertyId ?? ""}>
                            {props.find((property) => property.id === subitemsBinding?.childrenPropertyId)?.name
                              ?? databaseViewLabels().subitemPropertyName}
                          </option>
                          <option value={subitemsBinding?.parentPropertyId ?? ""}>
                            {props.find((property) => property.id === subitemsBinding?.parentPropertyId)?.name
                              ?? databaseViewLabels().parentItemPropertyName}
                          </option>
                        </select>
                      </label>
                      <label className={styles.taskFeatureCheckbox}>
                        <strong>{databaseViewLabels().showNestingToggleOnTitle}</strong>
                        <input
                          type="checkbox"
                          aria-label={databaseViewLabels().showNestingToggleOnTitle}
                          checked={subitemShowToggleOnTitle}
                          onChange={(event) => setSubitemShowToggleOnTitle(event.currentTarget.checked)}
                        />
                      </label>
                      <button
                        type="button"
                        className={styles.taskFeaturePrimary}
                        disabled={subitemsActivationBusy || subitemAdvancedSettingsUnchanged}
                        onClick={() => void saveSubitemAdvancedSettings()}
                      >
                        {databaseViewLabels().saveChanges}
                      </button>
                    </div>
                  </div>
                </>
              )}
            {open === "dependenciesSettings" &&
              renderToolbarMenuLayer(
                <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => closeToolbarMenu(true)}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().closeViewSettings}
                  />
                  <div
                    ref={toolbarMenuRef}
                    className={`${styles.toolbarMenu} ${styles.viewSettingsMenu} ${styles.taskFeatureMenu}`}
                    style={toolbarMenuStyle}
                    role="dialog"
                    aria-label={databaseViewLabels().dependencies}
                    aria-busy={dependencyActivationBusy}
                    onKeyDown={onToolbarMenuKeyDown}
                  >
                    <div className={styles.toolbarMenuHead}>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().additionalSettings}
                        onClick={() => openRelatedToolbarMenu("additionalSettings")}
                      >
                        <ArrowLeft size={13} aria-hidden="true" />
                      </button>
                      <div className={styles.toolbarMenuLabel}>{databaseViewLabels().dependencies}</div>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().closeViewSettings}
                        onClick={() => closeToolbarMenu(true)}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.taskFeatureBody}>
                      <p>{databaseViewLabels().dependenciesDescription}</p>
                      <fieldset className={styles.dependencyShiftOptions}>
                        <legend>{databaseViewLabels().automaticDateShifting}</legend>
                        {([
                          ["overlap", databaseViewLabels().dependencyShiftOverlap],
                          ["maintain_spacing", databaseViewLabels().dependencyShiftMaintain],
                          ["none", databaseViewLabels().dependencyShiftNone],
                        ] as const).map(([value, label]) => (
                          <label key={value}>
                            <input
                              type="radio"
                              name={`dependency-shift-${dbId}`}
                              value={value}
                              checked={dependencyShiftMode === value}
                              onChange={() => setDependencyShiftMode(value)}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </fieldset>
                      <label className={styles.taskFeatureCheckbox}>
                        <span>
                          <strong>{databaseViewLabels().avoidWeekends}</strong>
                          <small>{databaseViewLabels().avoidWeekendsDescription}</small>
                        </span>
                        <input
                          type="checkbox"
                          aria-label={databaseViewLabels().avoidWeekends}
                          checked={dependencyAvoidWeekends}
                          onChange={(event) => setDependencyAvoidWeekends(event.currentTarget.checked)}
                        />
                      </label>
                      {dateProps.length >= 2 && (
                        <label className={styles.taskFeatureCheckbox}>
                          <strong>{databaseViewLabels().separateStartEndDates}</strong>
                          <input
                            type="checkbox"
                            aria-label={databaseViewLabels().separateStartEndDates}
                            checked={dependencySeparateDates}
                            onChange={(event) => setDependencyDateMode(event.currentTarget.checked)}
                          />
                        </label>
                      )}
                      {dependencySeparateDates ? (
                        <>
                          <label className={styles.taskFeatureSelect}>
                            <span>{databaseViewLabels().startDate}</span>
                            <select
                              aria-label={databaseViewLabels().startDate}
                              value={dependencyStartDatePropertyId}
                              onChange={(event) => setDependencyStartDatePropertyId(event.currentTarget.value)}
                            >
                              {dateProps.map((property) => (
                                <option
                                  key={property.id}
                                  value={property.id}
                                  disabled={property.id === dependencyEndDatePropertyId}
                                >
                                  {property.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className={styles.taskFeatureSelect}>
                            <span>{databaseViewLabels().endDate}</span>
                            <select
                              aria-label={databaseViewLabels().endDate}
                              value={dependencyEndDatePropertyId}
                              onChange={(event) => setDependencyEndDatePropertyId(event.currentTarget.value)}
                            >
                              {dateProps.map((property) => (
                                <option
                                  key={property.id}
                                  value={property.id}
                                  disabled={property.id === dependencyStartDatePropertyId}
                                >
                                  {property.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        </>
                      ) : (
                        <label className={styles.taskFeatureSelect}>
                          <span>{databaseViewLabels().moveBasedOn}</span>
                          <select
                            aria-label={databaseViewLabels().moveBasedOn}
                            value={dependencyDatePropertyId}
                            onChange={(event) => setDependencyDatePropertyId(event.currentTarget.value)}
                          >
                            {dateProps.length === 0 && (
                              <option value="">{databaseViewLabels().noDateProperty}</option>
                            )}
                            {dateProps.map((property) => (
                              <option key={property.id} value={property.id}>{property.name}</option>
                            ))}
                          </select>
                        </label>
                      )}
                      <button
                        type="button"
                        className={styles.taskFeaturePrimary}
                        disabled={
                          !dependencyDateBindingValid
                          || dependencyActivationBusy
                          || dependencySettingsUnchanged
                        }
                        onClick={() => void activateDependencies()}
                      >
                        {dependenciesEnabled
                          ? databaseViewLabels().saveDependencySettings
                          : databaseViewLabels().turnOnDependencies}
                      </button>
                      {dependenciesEnabled && (
                        <button
                          type="button"
                          className={styles.taskFeatureSecondary}
                          disabled={dependencyActivationBusy}
                          onClick={() => openTaskFeatureTurnOff("dependencies")}
                        >
                          <span>{databaseViewLabels().turnOffDependencies}</span>
                        </button>
                      )}
                    </div>
                  </div>
                </>
              )}
            {open === "taskFeatureTurnOffConfirmation" &&
              renderToolbarMenuLayer(
                <>
                  <button
                    type="button"
                    className={styles.menuBackdrop}
                    onClick={() => openRelatedToolbarMenu(
                      turnOffFeature === "subitems" ? "subitemsSettings" : "dependenciesSettings"
                    )}
                    tabIndex={-1}
                    aria-label={databaseViewLabels().cancel}
                  />
                  <div
                    ref={toolbarMenuRef}
                    className={`${styles.toolbarMenu} ${styles.viewSettingsMenu} ${styles.taskFeatureMenu}`}
                    style={toolbarMenuStyle}
                    role="dialog"
                    aria-label={turnOffFeature === "subitems"
                      ? databaseViewLabels().turnOffSubitems
                      : databaseViewLabels().turnOffDependencies}
                    aria-busy={turnOffFeature === "subitems"
                      ? subitemsActivationBusy
                      : dependencyActivationBusy}
                    onKeyDown={onToolbarMenuKeyDown}
                  >
                    <div className={styles.toolbarMenuHead}>
                      <span />
                      <div className={styles.toolbarMenuLabel}>
                        {turnOffFeature === "subitems"
                          ? databaseViewLabels().turnOffSubitems
                          : databaseViewLabels().turnOffDependencies}
                      </div>
                      <button
                        type="button"
                        className={styles.toolbarMenuClear}
                        aria-label={databaseViewLabels().cancel}
                        onClick={() => openRelatedToolbarMenu(
                          turnOffFeature === "subitems" ? "subitemsSettings" : "dependenciesSettings"
                        )}
                      >
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.taskFeatureBody}>
                      <fieldset className={styles.dependencyShiftOptions}>
                        <label>
                          <input
                            type="radio"
                            name={`turn-off-disposition-${dbId}`}
                            value="remove"
                            checked={turnOffPropertyDisposition === "remove"}
                            onChange={() => setTurnOffPropertyDisposition("remove")}
                          />
                          <span>{databaseViewLabels().removeProperties}</span>
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`turn-off-disposition-${dbId}`}
                            value="keep"
                            checked={turnOffPropertyDisposition === "keep"}
                            onChange={() => setTurnOffPropertyDisposition("keep")}
                          />
                          <span>{databaseViewLabels().keepProperties}</span>
                        </label>
                      </fieldset>
                      <button
                        type="button"
                        className={styles.taskFeatureDanger}
                        disabled={turnOffFeature === "subitems"
                          ? subitemsActivationBusy
                          : dependencyActivationBusy}
                        onClick={() => void confirmTaskFeatureTurnOff()}
                      >
                        {databaseViewLabels().turnOff}
                      </button>
                    </div>
                  </div>
                </>
              )}
      </div>
      <div className={styles.dbToolbarSpacer} />
      {!readOnly && (
        <div className={styles.toolbarPopoverWrap}>
          <div className={styles.newTemplateSplit}>
            <button
              type="button"
              className={styles.newTemplateButton}
              onClick={() => void createRowFromTemplate()}
              aria-label={
                defaultTemplate
                  ? databaseViewLabels().newPageFromTemplate(templateDisplayName(defaultTemplate))
                  : databaseViewLabels().newDatabasePage
              }
              title={
                defaultTemplate
                  ? databaseViewLabels().newFromTemplate(templateDisplayName(defaultTemplate))
                  : databaseViewLabels().newPage
              }
            >
              <Plus size={14} aria-hidden="true" />
              {newPageLabel}
            </button>
            <button
              type="button"
              className={styles.newTemplateArrow}
              aria-label={databaseViewLabels().chooseDatabaseTemplate}
              aria-haspopup="dialog"
              aria-expanded={open === "templates"}
              onClick={(e) => toggleMenu("templates", e.currentTarget)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </div>
          {open === "templates" &&
            renderToolbarMenuLayer(
              <>
              <button
                type="button"
                className={styles.menuBackdrop}
                onClick={() => closeToolbarMenu(true)}
                tabIndex={-1}
                aria-label={databaseViewLabels().closeNewPageMenu}
              />
              <div
                ref={toolbarMenuRef}
                className={`${styles.toolbarMenu} ${styles.templateMenu}`}
                style={toolbarMenuStyle}
                role="dialog"
                aria-label={databaseViewLabels().newDatabasePage}
                onKeyDown={onToolbarMenuKeyDown}
              >
                <button
                  type="button"
                  className={styles.templatePrimary}
                  onClick={() => void createRowFromTemplate("")}
                >
                  <span className={styles.templateIcon}>
                    <FileText size={15} aria-hidden="true" />
                  </span>
                  <span>
                    <span>{databaseViewLabels().newPage}</span>
                    <span>
                      {defaultTemplate
                        ? databaseViewLabels().createWithoutTemplate
                        : databaseViewLabels().createEmptyPage}
                    </span>
                  </span>
                </button>
                <div className={styles.templateSearch}>
                  <Search size={14} aria-hidden="true" />
                  <input
                    ref={templateSearchRef}
                    value={templateSearch}
                    placeholder={databaseViewLabels().searchTemplates}
                    aria-label={databaseViewLabels().searchTemplates}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key !== "ArrowDown") return;
                      e.preventDefault();
                      const items = toolbarMenuItems();
                      const index = items.findIndex((item) => item === e.currentTarget);
                      items[index + 1]?.focus();
                    }}
                  />
                </div>
                <div className={styles.toolbarMenuLabel}>{databaseViewLabels().newFromTemplatesLabel}</div>
                {templates.length === 0 ? (
                  <div className={styles.templateEmpty}>{databaseViewLabels().noTemplates}</div>
                ) : filteredTemplates.length === 0 ? (
                  <div className={styles.templateEmpty}>{databaseViewLabels().noTemplatesFound}</div>
                ) : (
                  <div className={styles.templateList}>
                    {filteredTemplates.map((template) => (
                      <div className={styles.templateRow} key={template.id}>
                        <button
                          type="button"
                          className={styles.templateUse}
                          onClick={() => void createRowFromTemplate(template.id)}
                        >
                          <span className={styles.templateIcon}>
                            <TemplateIconGlyph icon={template.icon} />
                          </span>
                          <span>
                            {templateDisplayName(template)}
                            {template.isDefault ? databaseViewLabels().defaultSuffix : ""}
                          </span>
                        </button>
                        <button
                          type="button"
                          className={styles.templateDefault}
                          data-active={template.isDefault ? "true" : undefined}
                          onClick={() => toggleTemplateDefault(template)}
                        >
                          {template.isDefault ? databaseViewLabels().defaultLabel : databaseViewLabels().setDefault}
                        </button>
                        <button
                          type="button"
                          className={styles.templateEdit}
                          onClick={() => {
                            rememberTemplateEditorReturnFocus();
                            setOpen(null);
                            setEditingTemplateId(template.id);
                          }}
                        >
                          {databaseViewLabels().edit}
                        </button>
                        <button
                          type="button"
                          className={styles.templateDuplicate}
                          aria-label={databaseViewLabels().duplicateTemplateAria(templateDisplayName(template))}
                          title={databaseViewLabels().duplicate}
                          onClick={() => void duplicateAndEditTemplate(template.id)}
                        >
                          <Copy />
                        </button>
                        <button
                          type="button"
                          className={styles.templateDelete}
                          aria-label={databaseViewLabels().deleteTemplateAria(templateDisplayName(template))}
                          onClick={() => void deleteTemplateWithFeedback(template)}
                        >
                          <Trash size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className={styles.templateSectionDivider} />
                <button
                  type="button"
                  className={styles.templateNewItem}
                  aria-label={databaseViewLabels().createTemplateAria}
                  onClick={() => void createTemplate()}
                >
                  <span className={styles.templateIcon}>
                    <Plus size={15} aria-hidden="true" />
                  </span>
                  <span>{databaseViewLabels().createTemplate}</span>
                </button>
              </div>
              </>
            )}
        </div>
      )}
      {editingTemplate && (
        <TemplateEditorDialog
          key={editingTemplate.id}
          dbId={dbId}
          view={view}
          readOnly={readOnly}
          template={editingTemplate}
          returnFocusTarget={templateEditorReturnFocusRef.current}
          onClose={() => setEditingTemplateId(null)}
          onUse={async (beforeHandoff) => {
            const created = await createRowFromTemplate(editingTemplate.id);
            if (!created) return false;
            beforeHandoff();
            setEditingTemplateId(null);
            return true;
          }}
          onDuplicate={(beforeHandoff) =>
            duplicateAndEditTemplate(editingTemplate.id, beforeHandoff)
          }
          onUpdate={(patch) => updateTemplate(editingTemplate.id, patch)}
        />
      )}
      {typeChangeConfirmDialog}
    </div>
  );
}

function templateEditorFocusables(root: HTMLElement | null) {
  return Array.from(
    root?.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([type="hidden"]):not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [contenteditable="true"], ' +
        '[tabindex]:not([tabindex="-1"])'
    ) ?? []
  ).filter(
    (element) => {
      if (
        element.tabIndex < 0 ||
        element.matches(":disabled") ||
        element.getAttribute("aria-disabled") === "true" ||
        element.closest('[aria-hidden="true"], [hidden], [inert], fieldset:disabled')
      ) {
        return false;
      }
      for (let current: HTMLElement | null = element; current; current = current.parentElement) {
        const style = window.getComputedStyle(current);
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (current === root) break;
      }
      return true;
    }
  );
}

function TemplateEditorDialog({
  dbId,
  view,
  readOnly = false,
  template,
  returnFocusTarget,
  onClose,
  onUse,
  onDuplicate,
  onUpdate,
}: {
  dbId: string;
  view?: DbView;
  readOnly?: boolean;
  template: DbTemplate;
  returnFocusTarget?: HTMLElement | null;
  onClose: () => void;
  onUse: (beforeHandoff: () => void) => Promise<boolean>;
  onDuplicate: (beforeHandoff: () => void) => Promise<boolean>;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const dbPage = useStore((s) => s.pagesById[dbId]);
  const notify = useStore((s) => s.notify);
  const toggleFavorite = useStore((s) => s.toggleFavorite);
  const dialogRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusOnUnmountRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dbTitle = dbPage ? pageDisplayTitle(dbPage) : databaseViewLabels().databaseFallbackTitle;
  const templateTitle = templateDisplayName(template);
  const showBannerSourceIcon = !!dbPage?.icon || !startsWithEmojiIcon(dbTitle);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const ownedNodes = [dialogRef.current, backdropRef.current].filter(
      (node): node is HTMLElement => node instanceof HTMLElement
    );
    const isolated = Array.from(document.body.children)
      .filter((element) => !ownedNodes.some((node) => element === node || element.contains(node)))
      .map((element) => {
        const htmlElement = element as HTMLElement;
        const state = {
          element: htmlElement,
          inert: htmlElement.inert,
          ariaHidden: htmlElement.getAttribute("aria-hidden"),
        };
        htmlElement.inert = true;
        htmlElement.setAttribute("aria-hidden", "true");
        return state;
      });
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      templateEditorFocusables(dialog)[0]?.focus();
      if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
    });
    return () => {
      document.body.style.overflow = previous;
      window.cancelAnimationFrame(frame);
      for (const state of isolated) {
        state.element.inert = state.inert;
        if (state.ariaHidden === null) state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      if (restoreFocusOnUnmountRef.current) {
        window.requestAnimationFrame(() => {
          if (returnFocusTarget?.isConnected) {
            returnFocusTarget.focus();
            return;
          }
          const currentToolbar = Array.from(
            document.querySelectorAll<HTMLElement>("[data-database-toolbar]")
          ).find((element) => element.dataset.databaseToolbar === dbId);
          currentToolbar?.focus();
        });
      }
    };
  }, [dbId, returnFocusTarget]);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  function close() {
    restoreFocusOnUnmountRef.current = true;
    onClose();
  }

  async function applyTemplate() {
    setMenuOpen(false);
    const used = await onUse(() => {
      restoreFocusOnUnmountRef.current = false;
    });
    if (!used) {
      restoreFocusOnUnmountRef.current = true;
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
  }

  async function duplicateFromEditor(restoreMenuButton = false) {
    setMenuOpen(false);
    if (restoreMenuButton) {
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
    }
    await onDuplicate(() => {
      restoreFocusOnUnmountRef.current = false;
    });
  }

  function onDialogEscapeKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
    if (e.key !== "Escape") return;
    if (menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
      window.requestAnimationFrame(() => menuButtonRef.current?.focus());
      return;
    }
    const target = e.target instanceof HTMLElement ? e.target : null;
    const nestedDialog = target?.closest<HTMLElement>('[role="dialog"]');
    if (nestedDialog && nestedDialog !== dialogRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }

  function onDialogTabKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented || isComposingKeyEvent(e)) return;
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    const target = e.target instanceof Node ? e.target : null;
    // React events from portaled descendants still bubble through this
    // component. Let the portal's own menu/dialog keyboard contract run
    // before applying the DOM-contained editor trap.
    if (dialog && target && !dialog.contains(target)) return;
    const focusables = templateEditorFocusables(dialog);
    if (!dialog || focusables.length === 0) {
      e.preventDefault();
      dialog?.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!active || !dialog.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function copyTemplateSourceLink() {
    const ok = await copyText(absolutePageUrl(dbId));
    setCopied(ok);
    window.setTimeout(() => setCopied(false), 1200);
    notify(
      ok ? databaseViewLabels().linkCopiedToast : databaseViewLabels().copyLinkFailed,
      ok ? "success" : "error"
    );
  }

  async function toggleTemplateSourceFavorite() {
    if (!dbPage) return;
    const wasFavorite = !!dbPage.isFavorite;
    try {
      await toggleFavorite(dbId);
      notify(
        wasFavorite ? databaseViewLabels().removedFromFavorites : databaseViewLabels().addedToFavorites,
        "success"
      );
    } catch {
      notify(databaseViewLabels().updateFavoritesFailed, "error");
    }
  }

  const dialog = (
    <>
      <button
        ref={backdropRef}
        type="button"
        className={styles.templateEditorBackdrop}
        data-mode={expanded ? "page" : "peek"}
        onClick={close}
        tabIndex={-1}
        aria-label={databaseViewLabels().closeTemplateEditorPlain}
      />
      <section
        ref={dialogRef}
        className={styles.templateEditor}
        data-mode={expanded ? "page" : "peek"}
        role="dialog"
        aria-modal="true"
        aria-label={databaseViewLabels().editDatabaseTemplate}
        tabIndex={-1}
        onKeyDownCapture={onDialogTabKeyDown}
        onKeyDown={onDialogEscapeKeyDown}
      >
        <div className={styles.templateEditorTop}>
          <div
            className={styles.templateEditorChromeSide}
            aria-label={databaseViewLabels().templateViewOptions(templateTitle)}
          >
            <button
              type="button"
              className={styles.templatePeekIcon}
              data-template-editor-close="true"
              title={databaseViewLabels().closeTemplateEditor(templateTitle)}
              aria-label={databaseViewLabels().closeTemplateEditor(templateTitle)}
              onClick={close}
            >
              <DoubleChevronRight size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.templatePeekIcon}
              data-template-editor-open-page="true"
              title={expanded ? databaseViewLabels().collapseTemplateEditor : databaseViewLabels().expandTemplateEditor}
              aria-label={
                expanded ? databaseViewLabels().collapseTemplateEditor : databaseViewLabels().expandTemplateEditor
              }
              aria-pressed={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              <OpenAsPage size={15} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.templateEditorActions}>
            <button
              type="button"
              className={styles.templateShareAction}
              title={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyShareLink(dbTitle)}
              aria-label={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyShareLink(dbTitle)}
              onClick={() => void copyTemplateSourceLink()}
            >
              <SharePeopleIcon size={15} aria-hidden="true" />
              <span>{databaseViewLabels().share}</span>
            </button>
            <button
              type="button"
              className={styles.templateIconAction}
              title={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyLink(dbTitle)}
              aria-label={copied ? databaseViewLabels().linkCopied(dbTitle) : databaseViewLabels().copyLink(dbTitle)}
              onClick={() => void copyTemplateSourceLink()}
            >
              <LinkIcon size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={styles.templateIconAction}
              title={
                dbPage?.isFavorite
                  ? databaseViewLabels().removeFromFavorites(dbTitle)
                  : databaseViewLabels().addToFavorites(dbTitle)
              }
              aria-label={
                dbPage?.isFavorite
                  ? databaseViewLabels().removeFromFavorites(dbTitle)
                  : databaseViewLabels().addToFavorites(dbTitle)
              }
              onClick={() => void toggleTemplateSourceFavorite()}
            >
              {dbPage?.isFavorite ? (
                <StarFilled size={17} aria-hidden="true" />
              ) : (
                <Star size={17} aria-hidden="true" />
              )}
            </button>
            <div className={styles.templateActionWrap} ref={menuRef}>
              <button
                ref={menuButtonRef}
                type="button"
                className={styles.templateIconAction}
                title={databaseViewLabels().openTemplateActions}
                aria-label={databaseViewLabels().openTemplateActions}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((current) => !current)}
              >
                <DotsHorizontal size={16} aria-hidden="true" />
              </button>
              {menuOpen && (
                <div className={styles.templateActionMenu} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => void duplicateFromEditor(true)}
                  >
                    <Copy size={14} aria-hidden="true" />
                    {databaseViewLabels().duplicate}
                  </button>
                  <button type="button" role="menuitem" onClick={() => void applyTemplate()}>
                    <Plus size={14} aria-hidden="true" />
                    {databaseViewLabels().newPageMenuItem}
                  </button>
                  <label>
                    <input
                      type="checkbox"
                      checked={!!template.isDefault}
                      onChange={(e) => {
                        onUpdate({ isDefault: e.target.checked });
                        setMenuOpen(false);
                      }}
                    />
                    {databaseViewLabels().defaultTemplateForNewPages}
                  </label>
                  <button type="button" role="menuitem" onClick={close}>
                    <X size={14} aria-hidden="true" />
                    {databaseViewLabels().close}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className={styles.templateEditorBanner}>
          <span>{databaseViewLabels().editingTemplateIn}</span>
          <span className={styles.templateEditorBannerSource}>
            {showBannerSourceIcon ? <TemplateIconGlyph icon={dbPage?.icon} size={16} /> : null}
            {dbTitle}
          </span>
          <span className={styles.templateBannerHelp} aria-hidden="true">
            ?
          </span>
          <button
            type="button"
            className={styles.templateBannerDuplicate}
            onClick={() => void duplicateFromEditor(false)}
          >
            <Copy size={14} aria-hidden="true" />
            {databaseViewLabels().duplicateGive}
          </button>
        </div>
        {menuOpen && (
          <button
            type="button"
            className={styles.menuBackdrop}
            onClick={() => setMenuOpen(false)}
            tabIndex={-1}
            aria-label={databaseViewLabels().closeTemplateActions}
          />
        )}
        <div className={`${styles.templateEditorScroll} nscroll`}>
          <div className={styles.templateEditorDoc}>
            <TemplateIconPicker template={template} onUpdate={onUpdate} />
            <input
              className={styles.templateEditorName}
              value={templateTitleValue(template)}
              aria-label={databaseViewLabels().templatePageTitle}
              placeholder={databaseViewLabels().templatePageTitlePlaceholder}
              onChange={(e) => onUpdate({ title: e.target.value })}
            />
            <TemplatePageContent
              dbId={dbId}
              view={view}
              readOnly={readOnly}
              template={template}
              onUpdate={onUpdate}
            />
          </div>
        </div>
      </section>
    </>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

const EMPTY_TEMPLATE_EDITOR_BLOCKS: Block[] = [];

function templateIconType(icon?: string): Page["iconType"] {
  if (!icon) return "none";
  if (/^(https?:|data:|blob:)/.test(icon)) return "image";
  return "emoji";
}

function templatePropertiesOrEmpty(properties?: Record<string, unknown>) {
  return properties ?? {};
}

function cleanTemplateProperties(properties?: Record<string, unknown>) {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    next[key] = value;
  }
  return next;
}

function TemplatePageContent({
  dbId,
  view,
  readOnly = false,
  template,
  onUpdate,
}: {
  dbId: string;
  view?: DbView;
  readOnly?: boolean;
  template: DbTemplate;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const pageId = useMemo(() => templateEditorPageId(template.id), [template.id]);
  const workspaceId = useStore((s) => s.pagesById[dbId]?.workspaceId ?? s.workspace?.id ?? "");
  const row = useStore((s) => s.pagesById[pageId]);
  const blocks = useStore(
    useShallow((s) => s.blocksByPage[pageId] ?? EMPTY_TEMPLATE_EDITOR_BLOCKS)
  );
  const seededTemplateRef = useRef<string | null>(null);
  const lastBlocksSerializedRef = useRef("");
  const lastPropertiesSerializedRef = useRef("");
  // The seed effect below fires once per template.id (guarded by
  // seededTemplateRef) and must NOT re-seed when other template fields change —
  // those changes are handed to the sync effects that follow. Read the live
  // template through a ref so the seed reads current values without listing
  // every field as a dep (which would re-run and wipe the synthetic page).
  const templateRef = useRef(template);
  useEffect(() => {
    templateRef.current = template;
  });
  const templateTitle = templateTitleValue(template);

  useEffect(() => {
    const liveTemplate = templateRef.current;
    const now = new Date().toISOString();
    const initialBlocks = templateBlocksToEditorBlocks(
      pageId,
      templateBlocksOrDefault(liveTemplate.blocks),
      now
    );
    const initialProperties = templatePropertiesOrEmpty(liveTemplate.properties);
    const syntheticPage: Page = {
      id: pageId,
      workspaceId,
      parentId: dbId,
      parentType: "database",
      kind: "page",
      title: templateTitleValue(liveTemplate) || databaseViewLabels().untitled,
      icon: liveTemplate.icon ?? "",
      iconType: templateIconType(liveTemplate.icon),
      properties: initialProperties,
      position: liveTemplate.position,
      createdAt: liveTemplate.createdAt ?? now,
      updatedAt: liveTemplate.updatedAt ?? now,
    };

    lastBlocksSerializedRef.current = JSON.stringify(editorBlocksToTemplateBlocks(initialBlocks));
    lastPropertiesSerializedRef.current = JSON.stringify(cleanTemplateProperties(initialProperties));
    seededTemplateRef.current = template.id;
    useStore.setState((state) => ({
      pagesById: {
        ...state.pagesById,
        [pageId]: syntheticPage,
      },
      blocksByPage: {
        ...state.blocksByPage,
        [pageId]: initialBlocks,
      },
      loadedBlockPages: new Set(state.loadedBlockPages).add(pageId),
    }));

    return () => {
      seededTemplateRef.current = null;
      useStore.setState((state) => {
        const pagesById = { ...state.pagesById };
        const blocksByPage = { ...state.blocksByPage };
        const blockHistoryByPage = { ...state.blockHistoryByPage };
        delete pagesById[pageId];
        delete blocksByPage[pageId];
        delete blockHistoryByPage[pageId];
        const loadedBlockPages = new Set(state.loadedBlockPages);
        loadedBlockPages.delete(pageId);
        return {
          pagesById,
          blocksByPage,
          blockHistoryByPage,
          loadedBlockPages,
        };
      });
    };
  }, [
    dbId,
    pageId,
    template.id,
    workspaceId,
  ]);

  useEffect(() => {
    const nextProperties = templatePropertiesOrEmpty(template.properties);
    lastPropertiesSerializedRef.current = JSON.stringify(cleanTemplateProperties(nextProperties));
    useStore.setState((state) => {
      const page = state.pagesById[pageId];
      if (!page) return {};
      return {
        pagesById: {
          ...state.pagesById,
          [pageId]: {
            ...page,
            title: templateTitle || databaseViewLabels().untitled,
            icon: template.icon ?? "",
            iconType: templateIconType(template.icon),
            properties: nextProperties,
            updatedAt: template.updatedAt ?? page.updatedAt,
          },
        },
      };
    });
  }, [pageId, templateTitle, template.icon, template.properties, template.updatedAt]);

  useEffect(() => {
    if (seededTemplateRef.current !== template.id || !row) return;
    const next = cleanTemplateProperties(row.properties);
    const serialized = JSON.stringify(next);
    if (serialized === lastPropertiesSerializedRef.current) return;
    lastPropertiesSerializedRef.current = serialized;
    onUpdate({ properties: next });
  }, [onUpdate, row, template.id]);

  useEffect(() => {
    if (seededTemplateRef.current !== template.id) return;
    const next = templateBlocksOrDefault(editorBlocksToTemplateBlocks(blocks));
    const serialized = JSON.stringify(next);
    if (serialized === lastBlocksSerializedRef.current) return;
    lastBlocksSerializedRef.current = serialized;
    onUpdate({ blocks: next });
  }, [blocks, onUpdate, template.id]);

  return (
    <>
      {row && (
        <div className={styles.templateSharedProperties} data-template-shared-properties="true">
          <RowProperties
            dbId={dbId}
            row={row}
            view={view}
            readOnly={readOnly}
            showBackReferences={false}
            showPropertyControls={false}
          />
        </div>
      )}
      <div className={styles.templateCommentsStub}>
        <div className={styles.templateCommentsHeading}>{databaseViewLabels().comments}</div>
        <div className={styles.templateCommentAdd}>
          <span>{databaseViewLabels().me}</span>
          <span>{databaseViewLabels().addComment}</span>
        </div>
      </div>
      <div className={styles.templateBodyDivider} />
      <div className={styles.templateSharedEditor} data-template-shared-editor="true">
        <Editor
          pageId={pageId}
          templateMode
          skipRemoteLoad
          readOnly={readOnly}
          showPageStarter={false}
          emptyBodyPrompt={templateBodyPlaceholder()}
        />
      </div>
    </>
  );
}

function TemplateIconPicker({
  template,
  onUpdate,
}: {
  template: DbTemplate;
  onUpdate: (patch: Partial<DbTemplate>) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  function closePicker() {
    setOpen(false);
    window.requestAnimationFrame(() => buttonRef.current?.focus());
  }

  function updateIcon(icon?: string) {
    onUpdate({ icon });
    closePicker();
  }

  return (
    <div
      className={styles.templateIconField}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || !open) return;
        e.preventDefault();
        e.stopPropagation();
        closePicker();
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={styles.templateIconButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={template.icon ? databaseViewLabels().changeTemplateIcon : databaseViewLabels().addTemplateIcon}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.templateIconLarge}>
          <TemplateIconGlyph icon={template.icon} size={18} />
        </span>
        <span>{template.icon ? databaseViewLabels().changeIcon : databaseViewLabels().addIcon}</span>
      </button>
      {open && (
        <EmojiPicker
          placement="inline"
          onPick={(emoji) => updateIcon(emoji)}
          onPickImage={(url) => updateIcon(url)}
          onRemove={() => updateIcon(undefined)}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
