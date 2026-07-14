import { i18next } from "@/i18n";
import { activeDateLocale } from "@/lib/i18n";
import type { BlockType } from "@/lib/types";
import { blockDefLabel, blockDefPlaceholder, getDef } from "./blocks";

// Resolve at call time so locale changes also apply to non-hook helpers.
export function blockItemText(key: string, values?: Record<string, unknown>) {
  return i18next.t(`blockItem:${key}`, values);
}

export function blockTypeLabel(type: BlockType) {
  return blockDefLabel(getDef(type));
}

export function blockTypePlaceholder(type: BlockType) {
  return blockDefPlaceholder(getDef(type));
}

export function blockItemLabels() {
  const t = i18next.t;
  return {
    addView: t("blockItem:addView"),
    cantCopyBlockHere: t("blockItem:cantCopyBlockHere"),
    cantMoveBlockHere: t("blockItem:cantMoveBlockHere"),
    copiedBlocks: (count: number) =>
      count === 1 ? t("blockItem:copiedBlock") : t("blockItem:copiedBlocks", { count }),
    copyViewLink: t("blockItem:copyViewLink"),
    couldntCut: t("blockItem:couldntCut"),
    cutBlocks: (count: number) =>
      count === 1 ? t("blockItem:cutBlock") : t("blockItem:cutBlocks", { count }),
    dateDisplayLocale: activeDateLocale(),
    databaseNotReady: t("blockItem:databaseNotReady"),
    databaseTitleHidden: t("blockItem:databaseTitleHidden"),
    deletedBlocks: (count: number) =>
      count === 1 ? t("blockItem:deletedBlock") : t("blockItem:deletedBlocks", { count }),
    duplicatedBlocks: (count: number) =>
      count === 1
        ? t("blockItem:duplicatedBlock")
        : t("blockItem:duplicatedBlocks", { count }),
    duplicateView: t("blockItem:duplicateView"),
    editIcon: t("blockItem:editIcon"),
    editLayout: t("blockItem:editLayout"),
    editTitle: t("blockItem:editTitle"),
    emptyTogglePrompt: t("blockItem:emptyTogglePrompt"),
    groupDate: t("blockItem:groupDate"),
    groupLinkToPage: t("blockItem:groupLinkToPage"),
    groupNewPage: t("blockItem:groupNewPage"),
    groupPeople: t("blockItem:groupPeople"),
    hideTitle: t("blockItem:hideTitle"),
    manageInCalendar: t("blockItem:manageInCalendar"),
    mentionToday: t("blockItem:mentionToday"),
    mentionTomorrow: t("blockItem:mentionTomorrow"),
    mentionYesterday: t("blockItem:mentionYesterday"),
    movedBlocks: (count: number) =>
      count === 1 ? t("blockItem:movedBlock") : t("blockItem:movedBlocks", { count }),
    nothingToUndo: t("blockItem:nothingToUndo"),
    openDatabase: (dbTitle: string) => t("blockItem:openDatabase", { title: dbTitle }),
    restoredBlocks: (count: number) =>
      count === 1 ? t("blockItem:restoredBlock") : t("blockItem:restoredBlocks", { count }),
    undidCopy: t("blockItem:undidCopy"),
    undidDuplicate: t("blockItem:undidDuplicate"),
    undidMove: t("blockItem:undidMove"),
    undo: t("blockItem:undo"),
    uploadComplete: t("blockItem:uploadComplete"),
    uploadedFiles: (count: number) =>
      count === 1 ? t("blockItem:uploadedFile") : t("blockItem:uploadedFiles", { count }),
    uploadFailed: (fileName: string) =>
      fileName
        ? t("blockItem:uploadFailed", { fileName })
        : t("blockItem:uploadFailedUnknown"),
    uploadFileTooLarge: t("blockItem:uploadFileTooLarge"),
    uploadUnsafeFileType: t("blockItem:uploadUnsafeFileType"),
    uploadFinalizing: t("blockItem:uploadFinalizing"),
    uploadingFile: (fileName: string) => t("blockItem:uploadingFile", { fileName }),
    uploadPreparing: t("blockItem:uploadPreparing"),
    uploadUploading: t("blockItem:uploadUploading"),
    viewDataSource: t("blockItem:viewDataSource"),
  };
}
