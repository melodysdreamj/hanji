import type { PropertyType } from "@/lib/types";
import {
  CalendarIcon,
  CheckboxIcon,
  ClockIcon,
  Copy,
  FileText,
  FormulaIcon,
  HashIcon,
  IdIcon,
  LinkIcon,
  MailIcon,
  PhoneIcon,
  RollupIcon,
  SelectIcon,
  StatusIcon,
  TextIcon,
  UserIcon,
} from "../icons";

export function PropertyTypeIcon({
  type,
  size = 15,
}: {
  type: PropertyType | "title";
  size?: number;
}) {
  if (type === "title" || type === "rich_text") return <TextIcon size={size} aria-hidden="true" />;
  if (type === "number") return <HashIcon size={size} aria-hidden="true" />;
  if (type === "select" || type === "multi_select") return <SelectIcon size={size} aria-hidden="true" />;
  if (type === "status") return <StatusIcon size={size} aria-hidden="true" />;
  if (type === "date") return <CalendarIcon size={size} aria-hidden="true" />;
  if (type === "person" || type === "created_by" || type === "last_edited_by") {
    return <UserIcon size={size} aria-hidden="true" />;
  }
  if (type === "checkbox") return <CheckboxIcon size={size} aria-hidden="true" />;
  if (type === "files") return <FileText size={size} aria-hidden="true" />;
  if (type === "relation" || type === "url") return <LinkIcon size={size} aria-hidden="true" />;
  if (type === "rollup") return <RollupIcon size={size} aria-hidden="true" />;
  if (type === "formula") return <FormulaIcon size={size} aria-hidden="true" />;
  if (type === "email") return <MailIcon size={size} aria-hidden="true" />;
  if (type === "phone") return <PhoneIcon size={size} aria-hidden="true" />;
  if (type === "unique_id") return <IdIcon size={size} aria-hidden="true" />;
  if (type === "created_time" || type === "last_edited_time") {
    return <ClockIcon size={size} aria-hidden="true" />;
  }
  return <Copy size={size} aria-hidden="true" />;
}
