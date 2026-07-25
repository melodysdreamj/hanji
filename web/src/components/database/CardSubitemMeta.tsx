"use client";

import { useTranslation } from "react-i18next";
import { pageDisplayTitle } from "@/lib/pageTitle";
import type { Page } from "@/lib/types";
import type { CardViewSubitemPresentation } from "./query";
import styles from "./database.module.css";

export function CardSubitemMeta({
  row,
  pagesById,
  presentation,
}: {
  row: Page;
  pagesById: Record<string, Page>;
  presentation: CardViewSubitemPresentation;
}) {
  const { t } = useTranslation("tableView");

  if (presentation.mode === "card_property") {
    const count = presentation.childCountByParent.get(row.id) ?? 0;
    if (count <= 0) return null;
    return (
      <span className={styles.subitemCount} data-subitem-count={count}>
        {t("tableView:subitemCount", { count })}
      </span>
    );
  }

  if (presentation.mode !== "flattened" || !row.subitemParentId) return null;
  const parent = pagesById[row.subitemParentId];
  const parentTitle = parent ? pageDisplayTitle(parent) : "";
  return (
    <span
      className={styles.subitemParentIndicator}
      data-subitem-parent-id={row.subitemParentId}
      title={t("tableView:subitemOf", { title: parentTitle })}
    >
      {t("tableView:subitemOf", { title: parentTitle })}
    </span>
  );
}
