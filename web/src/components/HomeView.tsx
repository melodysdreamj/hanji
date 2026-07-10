"use client";

import { useEffect } from "react";
import { useRouter } from "@/lib/router";
import { useShallow } from "zustand/react/shallow";
import { iconFaviconHref, setDocumentChrome } from "@/lib/documentChrome";
import { pickLabels } from "@/lib/i18n";
import { pageHref } from "@/lib/navigation";
import { canCreateWorkspacePage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import { Plus } from "@/icons/hanji";
import { WorkspaceIconGlyph } from "./PageIcon";
import { TopBar } from "./TopBar";
import styles from "./HomeView.module.css";

const HOME_LABELS = {
  en: {
    openingPage: "Opening page",
    workspace: "Workspace",
    emptyWorkspace: "Empty workspace",
    untitled: "Untitled",
    newPage: "New page",
  },
  ko: {
    openingPage: "페이지 여는 중",
    workspace: "워크스페이스",
    emptyWorkspace: "빈 워크스페이스",
    untitled: "제목 없음",
    newPage: "새 페이지",
  },
} as const;

export function HomeView({ autoOpenFirstPage = true }: { autoOpenFirstPage?: boolean }) {
  const labels = pickLabels(HOME_LABELS);
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
    return (
      <div className={styles.redirecting} aria-busy="true" aria-label={labels.openingPage} />
    );
  }

  return (
    <>
      <TopBar title={workspace?.name ?? labels.workspace} />
      <div className={styles.wrap} role="region" aria-label={labels.emptyWorkspace}>
        <section className={styles.emptyDoc} data-testid="empty-workspace-surface">
          <span className={styles.workspaceIcon} data-testid="empty-workspace-icon" aria-hidden="true">
            <WorkspaceIconGlyph icon={workspace?.icon} size={78} />
          </span>
          <h1 data-testid="empty-workspace-title">{labels.untitled}</h1>
          <button
            type="button"
            className={styles.newPageButton}
            data-testid="empty-workspace-create"
            disabled={!canCreatePage}
            onClick={newPage}
          >
            <Plus size={16} aria-hidden="true" />
            <span>{labels.newPage}</span>
          </button>
        </section>
      </div>
    </>
  );
}
