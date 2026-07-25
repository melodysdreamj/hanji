"use client";

import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  getWikiPageOwnersRemote,
  getWikiOwnerCandidatesRemote,
  listWikiPagesRemote,
  setWikiPageOwnersRemote,
  unverifyWikiPageRemote,
  verifyWikiPageRemote,
  type WikiCollectionView,
} from "@/lib/edgebase";
import { pageHref } from "@/lib/navigation";
import { pageDisplayTitle } from "@/lib/pageTitle";
import { isPageVerified } from "@/lib/pageVerification";
import { activeDateLocale } from "@/lib/i18n";
import { canManagePage } from "@/lib/permissions";
import { useStore } from "@/lib/store";
import type { Page, PageOwner, WorkspaceMember } from "@/lib/types";
import { PageIconGlyph } from "./PageIcon";
import { VerificationBadge } from "./VerificationBadge";
import styles from "./WikiView.module.css";

type WikiTab = "home" | WikiCollectionView;

interface CollectionState {
  view: WikiCollectionView | null;
  pages: Page[];
  owners: PageOwner[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_COLLECTION: CollectionState = {
  view: null,
  pages: [],
  owners: [],
  nextCursor: null,
  loading: false,
  error: null,
};

function mergeById<T extends { id: string }>(current: T[], incoming: T[]) {
  const merged = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values());
}

function ownerInitial(ownerId: string) {
  return ownerId.trim().slice(0, 1).toUpperCase() || "?";
}

function verificationStateLabel(page: Page, t: (key: string, options?: Record<string, unknown>) => string) {
  if (!isPageVerified(page)) return null;
  if (!page.verificationExpiresAt) return t("verifiedIndefinitely");
  const date = new Date(page.verificationExpiresAt).toLocaleDateString(activeDateLocale(), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  return t("verifiedUntil", { date });
}

export function WikiPageSettingsDialog({
  page,
  initialOwners,
  onClose,
  onSaved,
}: {
  page: Page;
  initialOwners: PageOwner[];
  onClose: () => void;
  onSaved: (page: Page, owners: PageOwner[]) => void;
}) {
  const { t } = useTranslation("wikiView");
  const userId = useStore((state) => state.userId);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(initialOwners.map((owner) => owner.userId)),
  );
  const [expiry, setExpiry] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMoreOwners, setLoadingMoreOwners] = useState(false);
  const [ownerCursor, setOwnerCursor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getWikiPageOwnersRemote(page.id),
      getWikiOwnerCandidatesRemote(page.id, { limit: 50 }),
    ]).then(([ownerResult, memberResult]) => {
      if (cancelled) return;
      setSelected(new Set(ownerResult.owners.map((owner) => owner.userId)));
      setMembers(memberResult.members ?? []);
      setOwnerCursor(memberResult.nextCursor ?? null);
      setLoading(false);
    }).catch(() => {
      if (cancelled) return;
      setError(t("settingsLoadFailed"));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [page.id, page.workspaceId, t]);

  function applyResult(nextPage: Page, owners: PageOwner[]) {
    useStore.getState().applyRemotePagePatch(nextPage.id, nextPage);
    onSaved(nextPage, owners);
  }

  async function loadMoreOwners() {
    if (!ownerCursor || loadingMoreOwners) return;
    setLoadingMoreOwners(true);
    setError(null);
    try {
      const result = await getWikiOwnerCandidatesRemote(page.id, {
        after: ownerCursor,
        limit: 50,
      });
      setMembers((current) => mergeById(current, result.members ?? []));
      setOwnerCursor(result.nextCursor ?? null);
    } catch {
      setError(t("settingsLoadFailed"));
    } finally {
      setLoadingMoreOwners(false);
    }
  }

  async function saveOwners() {
    if (selected.size === 0 || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await setWikiPageOwnersRemote(
        page.id,
        Array.from(selected).sort(),
      );
      applyResult(result.page, result.owners);
    } catch {
      setError(t("settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function verify(expiresAt: string | null) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await verifyWikiPageRemote(page.id, expiresAt);
      applyResult(result.page, result.owners);
    } catch {
      setError(t("settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function unverify() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await unverifyWikiPageRemote(page.id);
      applyResult(result.page, result.owners);
    } catch {
      setError(t("settingsSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.dialogBackdrop} onMouseDown={onClose}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t("settingsTitle")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.dialogHeader}>
          <div>
            <strong>{t("settingsTitle")}</strong>
            <span>{pageDisplayTitle(page)}</span>
          </div>
          <button type="button" onClick={onClose} aria-label={t("closeSettings")}>×</button>
        </header>

        <div className={styles.dialogSection}>
          <h3>{t("owners")}</h3>
          {loading ? (
            <div className={styles.dialogStatus}>{t("loading")}</div>
          ) : members.length === 0 ? (
            <div className={styles.dialogStatus}>{t("noMembers")}</div>
          ) : (
            <div className={styles.memberList}>
              {members.map((member) => {
                const label = member.displayName?.trim()
                  || member.email?.trim()
                  || (member.userId === userId ? t("you") : member.userId);
                const checked = selected.has(member.userId);
                return (
                  <label key={member.id || member.userId} className={styles.memberOption}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving || (checked && selected.size === 1)}
                      onChange={() => {
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(member.userId)) next.delete(member.userId);
                          else next.add(member.userId);
                          return next;
                        });
                      }}
                    />
                    <span className={styles.memberAvatar} aria-hidden="true">
                      {ownerInitial(label)}
                    </span>
                    <span>
                      <strong>{label}</strong>
                      {member.email && <small>{member.email}</small>}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {ownerCursor && (
            <button
              type="button"
              className={styles.loadMore}
              disabled={loadingMoreOwners || saving}
              onClick={() => void loadMoreOwners()}
            >
              {loadingMoreOwners ? t("loading") : t("loadMore")}
            </button>
          )}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={loading || saving || selected.size === 0}
            onClick={() => void saveOwners()}
          >
            {saving ? t("saving") : t("saveOwners")}
          </button>
        </div>

        <div className={styles.dialogSection}>
          <h3>{t("verification")}</h3>
          <label className={styles.expiryField}>
            <span>{t("expiry")}</span>
            <input
              type="datetime-local"
              value={expiry}
              disabled={saving}
              onChange={(event) => setExpiry(event.currentTarget.value)}
            />
          </label>
          <div className={styles.dialogActions}>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={saving}
              onClick={() => void verify(null)}
            >
              {t("verifyIndefinitely")}
            </button>
            <button
              type="button"
              disabled={saving || !expiry}
              onClick={() => {
                const parsed = Date.parse(expiry);
                if (Number.isFinite(parsed)) void verify(new Date(parsed).toISOString());
              }}
            >
              {t("verifyUntil")}
            </button>
            {isPageVerified(page) && (
              <button type="button" className={styles.dangerButton} disabled={saving} onClick={() => void unverify()}>
                {t("removeVerification")}
              </button>
            )}
          </div>
        </div>
        {error && <div className={styles.dialogError} role="alert">{error}</div>}
      </section>
    </div>
  );
}

export function WikiView({ root, children }: { root: Page; children: ReactNode }) {
  const { t } = useTranslation("wikiView");
  const [tab, setTab] = useState<WikiTab>("home");
  const [collection, setCollection] = useState<CollectionState>(EMPTY_COLLECTION);
  const [settingsPageId, setSettingsPageId] = useState<string | null>(null);
  const pagesById = useStore((state) => state.pagesById);
  const workspace = useStore((state) => state.workspace);
  const currentMember = useStore((state) => state.currentMember);
  const pageRoles = useStore((state) => state.pageRolesById);
  const userId = useStore((state) => state.userId);

  async function load(view: WikiCollectionView, append = false) {
    if (collection.loading) return;
    setCollection((current) => ({
      ...(append && current.view === view ? current : EMPTY_COLLECTION),
      view,
      loading: true,
      error: null,
    }));
    const after = append && collection.view === view
      ? collection.nextCursor ?? undefined
      : undefined;
    try {
      const result = await listWikiPagesRemote(root.id, view, { after, limit: 50 });
      for (const page of result.pages) {
        useStore.getState().applyRemotePagePatch(page.id, page);
      }
      setCollection((current) => ({
        view,
        pages: append && current.view === view
          ? mergeById(current.pages, result.pages)
          : result.pages,
        owners: append && current.view === view
          ? mergeById(current.owners, result.owners)
          : result.owners,
        nextCursor: result.nextCursor,
        loading: false,
        error: null,
      }));
    } catch {
      setCollection((current) => ({
        ...current,
        view,
        loading: false,
        error: t("collectionLoadFailed"),
      }));
    }
  }

  useEffect(() => {
    if (tab === "home") return;
    if (collection.view === tab && (collection.loading || collection.pages.length > 0)) return;
    void load(tab);
    // The state guard above deliberately owns one request per selected view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const ownersByPage = useMemo(() => {
    const grouped = new Map<string, PageOwner[]>();
    for (const owner of collection.owners) {
      const current = grouped.get(owner.pageId) ?? [];
      current.push(owner);
      grouped.set(owner.pageId, current);
    }
    return grouped;
  }, [collection.owners]);
  const settingsPage = settingsPageId
    ? collection.pages.find((page) => page.id === settingsPageId)
      ?? pagesById[settingsPageId]
    : undefined;

  function updateCollectionPage(nextPage: Page, owners: PageOwner[]) {
    setCollection((current) => ({
      ...current,
      pages: current.pages.map((page) => page.id === nextPage.id ? nextPage : page),
      owners: [
        ...current.owners.filter((owner) => owner.pageId !== nextPage.id),
        ...owners,
      ],
    }));
  }

  return (
    <div className={styles.wiki}>
      <div className={styles.tabs} role="tablist" aria-label={pageDisplayTitle(root)}>
        {([
          ["home", t("home")],
          ["all", t("allPages")],
          ["owned", t("pagesIOwn")],
        ] as const).map(([value, label]) => (
          <button
            type="button"
            key={value}
            role="tab"
            aria-selected={tab === value}
            className={styles.tab}
            data-active={tab === value ? "true" : undefined}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "home" ? (
        <div role="tabpanel" className={styles.home}>{children}</div>
      ) : (
        <section role="tabpanel" className={styles.collection}>
          {collection.error && <div className={styles.collectionStatus} role="alert">{collection.error}</div>}
          {collection.loading && collection.pages.length === 0 ? (
            <div className={styles.collectionStatus}>{t("loading")}</div>
          ) : collection.pages.length === 0 ? (
            <div className={styles.collectionStatus}>{t("empty")}</div>
          ) : (
            <div className={styles.pageList}>
              {collection.pages.map((page) => {
                const owners = ownersByPage.get(page.id) ?? [];
                const verificationLabel = verificationStateLabel(page, t);
                const manageable = canManagePage({
                  page,
                  pagesById,
                  pageRoles,
                  workspace,
                  currentMember,
                  userId,
                }) || owners.some((owner) => owner.userId === userId);
                return (
                  <div key={page.id} className={styles.pageRow}>
                    <a href={pageHref(page.id)} className={styles.pageLink}>
                      <span className={styles.pageIcon}><PageIconGlyph page={page} size={18} /></span>
                      <span className={styles.pageTitle}>{pageDisplayTitle(page)}</span>
                    </a>
                    <span className={styles.verificationState}>
                      {verificationLabel && (
                        <>
                          <VerificationBadge page={page} compact />
                          <span>{verificationLabel}</span>
                        </>
                      )}
                    </span>
                    <div className={styles.ownerStack}>
                      {owners.slice(0, 4).map((owner) => {
                        const ownerLabel = owner.userId === userId ? t("you") : owner.userId;
                        return (
                          <span
                            key={owner.id}
                            className={styles.ownerAvatar}
                            aria-label={t("ownerAria", { owner: ownerLabel })}
                            title={ownerLabel}
                          >
                            {ownerInitial(ownerLabel)}
                          </span>
                        );
                      })}
                    </div>
                    {manageable && (
                      <button
                        type="button"
                        className={styles.manageButton}
                        aria-label={t("managePage", { title: pageDisplayTitle(page) })}
                        onClick={() => setSettingsPageId(page.id)}
                      >
                        •••
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {collection.nextCursor && (
            <button
              type="button"
              className={styles.loadMore}
              disabled={collection.loading}
              onClick={() => void load(tab, true)}
            >
              {t("loadMore")}
            </button>
          )}
        </section>
      )}

      {settingsPage && (
        <WikiPageSettingsDialog
          page={settingsPage}
          initialOwners={ownersByPage.get(settingsPage.id) ?? []}
          onClose={() => setSettingsPageId(null)}
          onSaved={updateCollectionPage}
        />
      )}
    </div>
  );
}
