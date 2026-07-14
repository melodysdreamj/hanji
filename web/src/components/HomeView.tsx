"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { iconFaviconHref, setDocumentChrome } from "@/lib/documentChrome";
import { pageHref } from "@/lib/navigation";
import { canCreateWorkspacePage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { Plus } from "@/icons/hanji";
import { WorkspaceIconGlyph } from "./PageIcon";
import { PageView } from "./PageView";
import { TopBar } from "./TopBar";
import styles from "./HomeView.module.css";

export function HomeView({ autoOpenFirstPage = true }: { autoOpenFirstPage?: boolean }) {
  const { t } = useTranslation(["homeView", "common"]);
  const router = useRouter();
  const workspace = useStore((s) => s.workspace);
  const currentMember = useStore((s) => s.currentMember);
  const userId = useStore((s) => s.userId);
  const roots = useStore(useShallow((s) => s.childPages(null)));
  const recent = useStore(useShallow((s) => s.recentPages()));
  const createPage = useStore((s) => s.createPage);
  const targetPage = recent[0] ?? roots[0];
  const canCreatePage = canCreateWorkspacePage({ workspace, currentMember, userId });

  useEffect(() => {
    setDocumentChrome({ title: "Hanji", iconHref: iconFaviconHref(workspace?.icon) });
  }, [workspace?.icon]);

  useEffect(() => {
    if (autoOpenFirstPage && targetPage) router.replace(pageHref(targetPage.id));
  }, [autoOpenFirstPage, router, targetPage]);

  async function newPage() {
    if (!canCreatePage) return;
    const last = roots[roots.length - 1];
    const page = await createPage({
      parentId: null,
      parentType: "workspace",
      afterPosition: last?.position,
    });
    router.push(pageHref(page.id));
  }

  if (autoOpenFirstPage && targetPage) {
    // Rendering does not need to wait for history.replaceState. The cached
    // target is already known, so show it in this same paint while the effect
    // canonicalizes the URL in the background.
    return <PageView pageId={targetPage.id} />;
  }

  return (
    <>
      <TopBar title={workspace?.name ?? t("homeView:workspace")} />
      <div className={styles.wrap} role="region" aria-label={t("homeView:emptyWorkspace")}>
        <section className={styles.emptyDoc} data-testid="empty-workspace-surface">
          <span className={styles.workspaceIcon} data-testid="empty-workspace-icon" aria-hidden="true">
            <WorkspaceIconGlyph icon={workspace?.icon} size={78} />
          </span>
          <h1 data-testid="empty-workspace-title">{t("homeView:untitled")}</h1>
          <button
            type="button"
            className={styles.newPageButton}
            data-testid="empty-workspace-create"
            disabled={!canCreatePage}
            onClick={newPage}
          >
            <Plus size={16} aria-hidden="true" />
            <span>{t("homeView:newPage")}</span>
          </button>
        </section>
      </div>
    </>
  );
}
