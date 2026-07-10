import type { BlockType } from "@/lib/types";
import {
  AudioIcon,
  BoardIcon,
  BookmarkIcon,
  BulletedListIcon,
  CalendarIcon,
  CalloutIcon,
  CaretRightFill,
  CheckboxIcon,
  CodeIcon,
  ColumnsIcon,
  Database,
  DividerIcon,
  EquationIcon,
  FileText,
  GalleryIcon,
  HeadingOneIcon,
  HeadingThreeIcon,
  HeadingTwoIcon,
  ImageIcon,
  LinkIcon,
  ListIcon,
  NumberedListIcon,
  OpenInNew,
  Plus,
  QuoteIcon,
  SyncIcon,
  TableIcon,
  TextIcon,
  TimelineIcon,
  VideoIcon,
} from "@/icons/hanji";
import type { BlockDef } from "./blocks";

type Props = {
  def?: Pick<BlockDef, "databaseView" | "glyph" | "group" | "type">;
  type?: BlockType;
  glyph?: string;
  size?: number;
};

export function BlockIcon({ def, type, glyph, size = 19 }: Props) {
  const blockType = type ?? def?.type;
  const fallback = glyph ?? def?.glyph ?? "¶";

  if (def?.group === "Database" || blockType === "child_database" || blockType === "inline_database") {
    if (def?.databaseView === "table") return <TableIcon size={size} aria-hidden="true" />;
    if (def?.databaseView === "board") return <BoardIcon size={size} aria-hidden="true" />;
    if (def?.databaseView === "list") return <ListIcon size={size} aria-hidden="true" />;
    if (def?.databaseView === "timeline") return <TimelineIcon size={size} aria-hidden="true" />;
    if (def?.databaseView === "calendar") return <CalendarIcon size={size} aria-hidden="true" />;
    if (def?.databaseView === "gallery") return <GalleryIcon size={size} aria-hidden="true" />;
    return <Database size={size} aria-hidden="true" />;
  }

  if (blockType === "child_page") return <FileText size={size} aria-hidden="true" />;
  if (blockType === "link_to_page") return <LinkIcon size={size} aria-hidden="true" />;
  if (blockType === "paragraph") return <TextIcon size={size} aria-hidden="true" />;
  if (blockType === "heading_1" || blockType === "toggle_heading_1") {
    return <HeadingOneIcon size={size} aria-hidden="true" />;
  }
  if (blockType === "heading_2" || blockType === "toggle_heading_2") {
    return <HeadingTwoIcon size={size} aria-hidden="true" />;
  }
  if (blockType === "heading_3" || blockType === "toggle_heading_3") {
    return <HeadingThreeIcon size={size} aria-hidden="true" />;
  }
  if (blockType === "heading_4" || blockType === "toggle_heading_4") {
    return <HeadingThreeIcon size={size} aria-hidden="true" />;
  }
  if (blockType === "to_do") return <CheckboxIcon size={size} aria-hidden="true" />;
  if (blockType === "bulleted_list_item") return <BulletedListIcon size={size} aria-hidden="true" />;
  if (blockType === "numbered_list_item") return <NumberedListIcon size={size} aria-hidden="true" />;
  if (blockType === "toggle") return <CaretRightFill size={size} aria-hidden="true" />;
  if (blockType === "quote") return <QuoteIcon size={size} aria-hidden="true" />;
  if (blockType === "callout") return <CalloutIcon size={size} aria-hidden="true" />;
  if (blockType === "divider") return <DividerIcon size={size} aria-hidden="true" />;
  if (blockType === "code") return <CodeIcon size={size} aria-hidden="true" />;
  if (blockType === "equation") return <EquationIcon size={size} aria-hidden="true" />;
  if (blockType === "table_of_contents") return <ListIcon size={size} aria-hidden="true" />;
  if (blockType === "synced_block") return <SyncIcon size={size} aria-hidden="true" />;
  if (blockType === "button") return <Plus size={size} aria-hidden="true" />;
  if (blockType === "tab" || blockType === "column_list") return <ColumnsIcon size={size} aria-hidden="true" />;
  if (blockType === "simple_table") return <TableIcon size={size} aria-hidden="true" />;
  if (blockType === "image") return <ImageIcon size={size} aria-hidden="true" />;
  if (blockType === "video") return <VideoIcon size={size} aria-hidden="true" />;
  if (blockType === "audio") return <AudioIcon size={size} aria-hidden="true" />;
  if (blockType === "bookmark") return <BookmarkIcon size={size} aria-hidden="true" />;
  if (blockType === "embed") return <OpenInNew size={size} aria-hidden="true" />;
  if (blockType === "file") return <FileText size={size} aria-hidden="true" />;

  return <>{fallback}</>;
}
