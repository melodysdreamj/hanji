import type { CSSProperties, ReactNode } from "react";
import { useWorkspaceFileUrl } from "@/lib/fileUrls";
import type { Page } from "@/lib/types";
import { safeStoredFileUrl } from "@/lib/urls";
import { Database, FileText } from "./icons";

function imageStyle(size: number): CSSProperties {
  return {
    display: "block",
    width: size,
    height: size,
    borderRadius: Math.max(3, Math.round(size * 0.18)),
    objectFit: "cover",
  };
}

export function looksLikeImageIcon(value?: string) {
  return !!safeStoredFileUrl(value, ["data:image/"]);
}

type PageIconSource = Pick<Page, "icon" | "iconType" | "kind">;

export function pageIconText(page: PageIconSource, fallback = "") {
  if (page.iconType === "emoji" && page.icon) return page.icon;
  if (page.kind === "database") return "DB";
  return fallback;
}

export function PageIconGlyph({
  page,
  size = 16,
  fallback = "file",
}: {
  page: PageIconSource;
  size?: number;
  fallback?: "file" | "database" | "none" | ReactNode;
}) {
  const iconUrl = useWorkspaceFileUrl(page.icon, ["data:image/"]);
  if (page.iconType === "image" && iconUrl) {
    return <img src={iconUrl} alt="" style={imageStyle(size)} loading="lazy" />;
  }
  if (page.iconType === "emoji" && page.icon) return page.icon;
  if (page.kind === "database" || fallback === "database") return <Database size={size} aria-hidden="true" />;
  if (fallback === "none") return null;
  if (fallback !== "file") return fallback;
  return <FileText size={size} aria-hidden="true" />;
}

export function PageIcon({
  page,
  size = 16,
  fallback = "file",
  className,
}: {
  page: PageIconSource;
  size?: number;
  fallback?: "file" | "database" | "none" | ReactNode;
  className?: string;
}) {
  return (
    <span className={className} aria-hidden="true">
      <PageIconGlyph page={page} size={size} fallback={fallback} />
    </span>
  );
}

export function WorkspaceIconGlyph({
  icon,
  size = 16,
  fallback = "📓",
}: {
  icon?: string;
  size?: number;
  fallback?: string;
}) {
  const cleanIcon = icon?.trim();
  const iconUrl = useWorkspaceFileUrl(cleanIcon, ["data:image/"]);
  if (iconUrl) {
    return <img src={iconUrl} alt="" style={imageStyle(size)} loading="lazy" />;
  }
  return cleanIcon || fallback;
}
