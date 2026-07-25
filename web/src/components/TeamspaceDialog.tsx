"use client";

import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useStore } from "@/lib/store";
import { isolateBodyForModal, trapModalTab } from "@/lib/modalFocus";
import {
  addTeamspaceMemberRemote,
  archiveTeamspaceRemote,
  createTeamspaceRemote,
  joinTeamspaceRemote,
  listArchivedTeamspacesRemote,
  listTeamspaceMembersRemote,
  listTeamspaceRequestsRemote,
  removeTeamspaceMemberRemote,
  requestTeamspaceAccessRemote,
  respondTeamspaceRequestRemote,
  restoreTeamspaceRemote,
  setDefaultTeamspaceRemote,
  updateTeamspaceMemberRoleRemote,
  updateTeamspaceRemote,
  updateTeamspaceSettingsRemote,
} from "@/lib/edgebase";
import type {
  ShareRole,
  Teamspace,
  TeamspaceAccess,
  TeamspaceJoinRequest,
  TeamspaceMember,
  TeamspaceMemberRole,
} from "@/lib/types";
import { X } from "./icons";
import styles from "./TeamspaceDialog.module.css";

type DialogView = "browse" | "create" | "manage" | "archived";

type TeamspaceDialogProps = {
  embedded?: boolean;
  initialView?: DialogView;
  onClose?: () => void;
};

const PAGE_ROLES: ShareRole[] = ["view", "comment", "edit", "full_access"];

function principalKey(type: "user" | "group", id: string) {
  return `${type}:${id}`;
}

export function TeamspaceDialog({
  embedded = false,
  initialView = "browse",
  onClose,
}: TeamspaceDialogProps) {
  const { t } = useTranslation(["teamspaceDialog", "common"]);
  const titleId = useId();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const workspace = useStore((state) => state.workspace);
  const currentMember = useStore((state) => state.currentMember);
  const userId = useStore((state) => state.userId);
  const teamspaces = useStore((state) => state.teamspaces);
  const discoverableTeamspaces = useStore((state) => state.discoverableTeamspaces);
  const teamspaceSettings = useStore((state) => state.teamspaceSettings);
  const workspaceMembers = useStore((state) => state.workspaceMembers);
  const organizationGroups = useStore((state) => state.organizationGroups);
  const refreshWorkspacePages = useStore((state) => state.refreshWorkspacePages);
  const notify = useStore((state) => state.notify);
  const [view, setView] = useState<DialogView>(initialView);
  const [selectedId, setSelectedId] = useState(teamspaces[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<TeamspaceMember[]>([]);
  const [requests, setRequests] = useState<TeamspaceJoinRequest[]>([]);
  const [archived, setArchived] = useState<Teamspace[]>([]);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [requestsCursor, setRequestsCursor] = useState<string | null>(null);
  const [archivedCursor, setArchivedCursor] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState("🧭");
  const [description, setDescription] = useState("");
  const [access, setAccess] = useState<TeamspaceAccess>("open");
  const [memberPageRole, setMemberPageRole] = useState<ShareRole>("edit");
  const [openPageRole, setOpenPageRole] = useState<ShareRole>("view");
  const [membersCanInvite, setMembersCanInvite] = useState(true);
  const [membersCanEditSidebar, setMembersCanEditSidebar] = useState(true);
  const [principal, setPrincipal] = useState("");
  const [principalRole, setPrincipalRole] = useState<TeamspaceMemberRole>("member");
  const [replacementDefaultId, setReplacementDefaultId] = useState("");

  const selected = useMemo(
    () => teamspaces.find((teamspace) => teamspace.id === selectedId),
    [selectedId, teamspaces],
  );
  const workspaceAdmin = workspace?.ownerId === userId
    || currentMember?.role === "owner"
    || currentMember?.role === "admin";
  const canManageSelected = workspaceAdmin || selected?.role === "owner";
  const canCreate = !!workspace && (
    !teamspaceSettings?.ownersOnlyCreate || currentMember?.role === "owner"
  );

  useEffect(() => {
    if (embedded) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const restoreIsolation = isolateBodyForModal([overlayRef.current]);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      restoreIsolation();
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restore?.isConnected) window.requestAnimationFrame(() => restore.focus());
    };
  }, [embedded]);

  useEffect(() => {
    if (teamspaces.length === 0 || teamspaces.some((teamspace) => teamspace.id === selectedId)) {
      return;
    }
    setSelectedId(teamspaces[0].id);
  }, [selectedId, teamspaces]);

  useEffect(() => {
    if (!selected) return;
    setName(selected.name);
    setIcon(selected.icon || "🧭");
    setDescription(selected.description || "");
    setAccess(selected.access);
    setMemberPageRole(selected.memberPageRole ?? "edit");
    setOpenPageRole(selected.openPageRole ?? "view");
    setMembersCanInvite(selected.membersCanInvite !== false);
    setMembersCanEditSidebar(selected.membersCanEditSidebar !== false);
    const replacement = teamspaces.find((teamspace) => teamspace.id !== selected.id);
    setReplacementDefaultId(replacement?.id ?? "");
  }, [selected, teamspaces]);

  useEffect(() => {
    if (!workspace || view !== "manage" || !selected || !canManageSelected) return;
    let cancelled = false;
    Promise.all([
      listTeamspaceMembersRemote(workspace.id, selected.id),
      listTeamspaceRequestsRemote(workspace.id, selected.id),
    ]).then(([memberResult, requestResult]) => {
      if (cancelled) return;
      setMembers(memberResult.members);
      setRequests(requestResult.requests);
      setMembersCursor(memberResult.hasMore ? memberResult.nextCursor ?? null : null);
      setRequestsCursor(requestResult.hasMore ? requestResult.nextCursor ?? null : null);
    }).catch((cause) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.load"));
    });
    return () => {
      cancelled = true;
    };
  }, [canManageSelected, selected, t, view, workspace]);

  useEffect(() => {
    if (!workspace || view !== "archived" || !workspaceAdmin) return;
    let cancelled = false;
    listArchivedTeamspacesRemote(workspace.id)
      .then((result) => {
        if (!cancelled) {
          setArchived(result.teamspaces);
          setArchivedCursor(result.hasMore ? result.nextCursor ?? null : null);
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.load"));
      });
    return () => {
      cancelled = true;
    };
  }, [t, view, workspace, workspaceAdmin]);

  async function execute(work: () => Promise<unknown>, success: string) {
    if (busy) return false;
    setBusy(true);
    setError(null);
    try {
      await work();
      await refreshWorkspacePages();
      notify(success, "success");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.action"));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function createTeamspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspace || !name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createTeamspaceRemote({
        workspaceId: workspace.id,
        name: name.trim(),
        icon: icon.trim() || "🧭",
        description: description.trim(),
        access,
        memberPageRole,
        openPageRole,
        membersCanInvite,
        membersCanEditSidebar,
      });
      if (!result.teamspace) return;
      await refreshWorkspacePages();
      setSelectedId(result.teamspace.id);
      setView("manage");
      notify(t("teamspaceDialog:notice.created"), "success");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.action"));
    } finally {
      setBusy(false);
    }
  }

  function openManage(teamspace: Teamspace) {
    setSelectedId(teamspace.id);
    setView("manage");
    setError(null);
  }

  function openView(nextView: DialogView) {
    setView(nextView);
    setError(null);
    if (nextView !== "create") return;
    setName("");
    setIcon("🧭");
    setDescription("");
    setAccess("open");
    setMemberPageRole("edit");
    setOpenPageRole("view");
    setMembersCanInvite(true);
    setMembersCanEditSidebar(true);
  }

  async function refreshManagement() {
    if (!workspace || !selected) return;
    const [memberResult, requestResult] = await Promise.all([
      listTeamspaceMembersRemote(workspace.id, selected.id),
      listTeamspaceRequestsRemote(workspace.id, selected.id),
    ]);
    setMembers(memberResult.members);
    setRequests(requestResult.requests);
    setMembersCursor(memberResult.hasMore ? memberResult.nextCursor ?? null : null);
    setRequestsCursor(requestResult.hasMore ? requestResult.nextCursor ?? null : null);
  }

  async function loadMoreMembers() {
    if (!workspace || !selected || !membersCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await listTeamspaceMembersRemote(workspace.id, selected.id, membersCursor);
      setMembers((current) => [
        ...current,
        ...result.members.filter((member) => !current.some((item) => item.id === member.id)),
      ]);
      setMembersCursor(result.hasMore ? result.nextCursor ?? null : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.load"));
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreRequests() {
    if (!workspace || !selected || !requestsCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await listTeamspaceRequestsRemote(workspace.id, selected.id, requestsCursor);
      setRequests((current) => [
        ...current,
        ...result.requests.filter((request) => !current.some((item) => item.id === request.id)),
      ]);
      setRequestsCursor(result.hasMore ? result.nextCursor ?? null : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.load"));
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreArchived() {
    if (!workspace || !archivedCursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await listArchivedTeamspacesRemote(workspace.id, archivedCursor);
      setArchived((current) => [
        ...current,
        ...result.teamspaces.filter((teamspace) => !current.some((item) => item.id === teamspace.id)),
      ]);
      setArchivedCursor(result.hasMore ? result.nextCursor ?? null : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("teamspaceDialog:error.load"));
    } finally {
      setBusy(false);
    }
  }

  const memberLabel = (membership: TeamspaceMember) => {
    if (membership.principalType === "group") {
      return organizationGroups.find((group) => group.id === membership.principalId)?.name
        ?? membership.principalId;
    }
    const workspaceMember = workspaceMembers.find((candidate) => (
      candidate.userId === membership.principalId
    ));
    return workspaceMember?.displayName || workspaceMember?.email || membership.principalId;
  };
  const requestLabel = (request: TeamspaceJoinRequest) => {
    const workspaceMember = workspaceMembers.find((candidate) => candidate.userId === request.userId);
    return workspaceMember?.displayName || workspaceMember?.email || request.userId;
  };
  const principalOptions = [
    ...workspaceMembers
      .filter((member) => member.role !== "guest")
      .map((member) => ({
        key: principalKey("user", member.userId),
        label: member.displayName || member.email || member.userId,
      })),
    ...organizationGroups.map((group) => ({
      key: principalKey("group", group.id),
      label: group.name,
    })),
  ];

  const dialog = (
    <div ref={overlayRef} className={embedded ? styles.embedded : styles.overlay}>
      {!embedded ? (
        <button
          type="button"
          className={styles.backdrop}
          onClick={() => !busy && onClose?.()}
          tabIndex={-1}
          aria-label={t("common:actions.close")}
        />
      ) : null}
      <section
        ref={dialogRef}
        className={`${styles.dialog} ${embedded ? styles.embeddedDialog : ""}`}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        data-teamspace-management={embedded ? "embedded" : "dialog"}
        onKeyDown={(event) => {
          if (embedded) return;
          if (event.key === "Escape") {
            event.preventDefault();
            if (!busy) onClose?.();
            return;
          }
          trapModalTab(event, dialogRef.current);
        }}
      >
        <header className={styles.header}>
          <div>
            <h2 id={titleId}>{t("teamspaceDialog:title")}</h2>
            <p>{t("teamspaceDialog:subtitle")}</p>
          </div>
          {!embedded ? (
            <button
              ref={closeRef}
              type="button"
              className={styles.close}
              onClick={onClose}
              disabled={busy}
              aria-label={t("common:actions.close")}
            >
              <X size={18} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <nav className={styles.tabs} aria-label={t("teamspaceDialog:tabs.label")}>
          {(["browse", "create", "manage", ...(workspaceAdmin ? ["archived"] : [])] as DialogView[])
            .filter((tab) => tab !== "create" || canCreate)
            .map((tab) => (
              <button
                key={tab}
                type="button"
                aria-current={view === tab ? "page" : undefined}
                onClick={() => openView(tab)}
              >
                {t(`teamspaceDialog:tabs.${tab}`)}
              </button>
            ))}
        </nav>
        <div className={styles.body}>
          {view === "browse" ? (
            <div className={styles.stack}>
              <h3>{t("teamspaceDialog:joined")}</h3>
              {teamspaces.length === 0 ? <p className={styles.muted}>{t("teamspaceDialog:noneJoined")}</p> : null}
              {teamspaces.map((teamspace) => (
                <div key={teamspace.id} className={styles.teamspaceRow}>
                  <span className={styles.icon} aria-hidden="true">{teamspace.icon || "🧭"}</span>
                  <span className={styles.rowBody}>
                    <strong>{teamspace.name}</strong>
                    <small>{teamspace.description || t(`teamspaceDialog:access.${teamspace.access}`)}</small>
                  </span>
                  <span className={styles.pill}>{t(`teamspaceDialog:access.${teamspace.access}`)}</span>
                  <button type="button" className={styles.secondary} onClick={() => openManage(teamspace)}>
                    {workspaceAdmin || teamspace.role === "owner"
                      ? t("teamspaceDialog:manage")
                      : t("teamspaceDialog:open")}
                  </button>
                </div>
              ))}
              <h3>{t("teamspaceDialog:available")}</h3>
              {discoverableTeamspaces.length === 0 ? (
                <p className={styles.muted}>{t("teamspaceDialog:noneAvailable")}</p>
              ) : null}
              {discoverableTeamspaces.map((teamspace) => (
                <div key={teamspace.id} className={styles.teamspaceRow}>
                  <span className={styles.icon} aria-hidden="true">{teamspace.icon || "🧭"}</span>
                  <span className={styles.rowBody}>
                    <strong>{teamspace.name}</strong>
                    <small>{teamspace.description || t(`teamspaceDialog:access.${teamspace.access}`)}</small>
                  </span>
                  {teamspace.canJoin ? (
                    <button
                      type="button"
                      className={styles.primary}
                      disabled={busy}
                      onClick={() => workspace && void execute(
                        () => joinTeamspaceRemote(workspace.id, teamspace.id),
                        t("teamspaceDialog:notice.joined"),
                      )}
                    >
                      {t("teamspaceDialog:join")}
                    </button>
                  ) : teamspace.requestPending ? (
                    <span className={styles.pill}>{t("teamspaceDialog:requestPending")}</span>
                  ) : (
                    <button
                      type="button"
                      className={styles.secondary}
                      disabled={busy || !teamspace.canRequest}
                      onClick={() => workspace && void execute(
                        () => requestTeamspaceAccessRemote(workspace.id, teamspace.id),
                        t("teamspaceDialog:notice.requested"),
                      )}
                    >
                      {t("teamspaceDialog:request")}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          {view === "create" ? (
            <form className={styles.form} onSubmit={createTeamspace}>
              <label>{t("teamspaceDialog:fields.name")}<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
              <label>{t("teamspaceDialog:fields.icon")}<input value={icon} maxLength={32} onChange={(event) => setIcon(event.target.value)} /></label>
              <label className={styles.wide}>{t("teamspaceDialog:fields.description")}<textarea value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
              <label>{t("teamspaceDialog:fields.access")}<select value={access} onChange={(event) => setAccess(event.target.value as TeamspaceAccess)}>{["open", "closed", "private"].map((value) => <option key={value} value={value}>{t(`teamspaceDialog:access.${value}`)}</option>)}</select></label>
              <label>{t("teamspaceDialog:fields.memberRole")}<select value={memberPageRole} onChange={(event) => setMemberPageRole(event.target.value as ShareRole)}>{PAGE_ROLES.map((role) => <option key={role} value={role}>{t(`teamspaceDialog:roles.${role}`)}</option>)}</select></label>
              <label>{t("teamspaceDialog:fields.openRole")}<select value={openPageRole} onChange={(event) => setOpenPageRole(event.target.value as ShareRole)}>{PAGE_ROLES.map((role) => <option key={role} value={role}>{t(`teamspaceDialog:roles.${role}`)}</option>)}</select></label>
              <label className={styles.check}><input type="checkbox" checked={membersCanInvite} onChange={(event) => setMembersCanInvite(event.target.checked)} />{t("teamspaceDialog:fields.membersCanInvite")}</label>
              <label className={styles.check}><input type="checkbox" checked={membersCanEditSidebar} onChange={(event) => setMembersCanEditSidebar(event.target.checked)} />{t("teamspaceDialog:fields.membersCanEditSidebar")}</label>
              <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || !name.trim()}>{t("teamspaceDialog:create")}</button></div>
            </form>
          ) : null}

          {view === "manage" ? (
            selected ? (
              <div className={styles.stack}>
                <label className={styles.selectLabel}>{t("teamspaceDialog:selectTeamspace")}
                  <select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>
                    {teamspaces.map((teamspace) => <option key={teamspace.id} value={teamspace.id}>{teamspace.name}</option>)}
                  </select>
                </label>
                {canManageSelected ? (
                  <>
                    <form className={styles.form} onSubmit={(event) => {
                      event.preventDefault();
                      if (!workspace) return;
                      void execute(() => updateTeamspaceRemote({
                        workspaceId: workspace.id,
                        teamspaceId: selected.id,
                        name: name.trim(), icon, description, access,
                        memberPageRole, openPageRole, membersCanInvite, membersCanEditSidebar,
                      }), t("teamspaceDialog:notice.saved"));
                    }}>
                      <label>{t("teamspaceDialog:fields.name")}<input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
                      <label>{t("teamspaceDialog:fields.icon")}<input value={icon} maxLength={32} onChange={(event) => setIcon(event.target.value)} /></label>
                      <label className={styles.wide}>{t("teamspaceDialog:fields.description")}<textarea value={description} maxLength={500} onChange={(event) => setDescription(event.target.value)} /></label>
                      <label>{t("teamspaceDialog:fields.access")}<select value={access} onChange={(event) => setAccess(event.target.value as TeamspaceAccess)}>{["open", "closed", "private"].map((value) => <option key={value} value={value}>{t(`teamspaceDialog:access.${value}`)}</option>)}</select></label>
                      <label>{t("teamspaceDialog:fields.memberRole")}<select value={memberPageRole} onChange={(event) => setMemberPageRole(event.target.value as ShareRole)}>{PAGE_ROLES.map((role) => <option key={role} value={role}>{t(`teamspaceDialog:roles.${role}`)}</option>)}</select></label>
                      <label>{t("teamspaceDialog:fields.openRole")}<select value={openPageRole} onChange={(event) => setOpenPageRole(event.target.value as ShareRole)}>{PAGE_ROLES.map((role) => <option key={role} value={role}>{t(`teamspaceDialog:roles.${role}`)}</option>)}</select></label>
                      <label className={styles.check}><input type="checkbox" checked={membersCanInvite} onChange={(event) => setMembersCanInvite(event.target.checked)} />{t("teamspaceDialog:fields.membersCanInvite")}</label>
                      <label className={styles.check}><input type="checkbox" checked={membersCanEditSidebar} onChange={(event) => setMembersCanEditSidebar(event.target.checked)} />{t("teamspaceDialog:fields.membersCanEditSidebar")}</label>
                      <div className={styles.actions}><button type="submit" className={styles.primary} disabled={busy || !name.trim()}>{t("teamspaceDialog:save")}</button></div>
                    </form>
                    <section className={styles.panel}>
                      <h3>{t("teamspaceDialog:members")}</h3>
                      <div className={styles.inlineForm}>
                        <select value={principal} onChange={(event) => setPrincipal(event.target.value)}><option value="">{t("teamspaceDialog:choosePrincipal")}</option>{principalOptions.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select>
                        <select value={principalRole} onChange={(event) => setPrincipalRole(event.target.value as TeamspaceMemberRole)}><option value="member">{t("teamspaceDialog:member")}</option><option value="owner">{t("teamspaceDialog:owner")}</option></select>
                        <button type="button" className={styles.secondary} disabled={busy || !principal} onClick={() => {
                          if (!workspace || !principal) return;
                          const [principalType, principalId] = principal.split(":", 2) as ["user" | "group", string];
                          void execute(() => addTeamspaceMemberRemote({ workspaceId: workspace.id, teamspaceId: selected.id, principalType, principalId, role: principalRole }), t("teamspaceDialog:notice.memberAdded")).then((ok) => {
                            if (ok) void refreshManagement();
                          });
                        }}>{t("teamspaceDialog:add")}</button>
                      </div>
                      {members.map((membership) => (
                        <div key={membership.id} className={styles.memberRow}>
                          <span>{memberLabel(membership)}</span>
                          <select value={membership.role} disabled={busy} onChange={(event) => workspace && void execute(() => updateTeamspaceMemberRoleRemote({ workspaceId: workspace.id, teamspaceId: selected.id, membershipId: membership.id, role: event.target.value as TeamspaceMemberRole }), t("teamspaceDialog:notice.memberUpdated")).then((ok) => {
                            if (ok) void refreshManagement();
                          })}><option value="member">{t("teamspaceDialog:member")}</option><option value="owner">{t("teamspaceDialog:owner")}</option></select>
                          <button type="button" className={styles.dangerText} disabled={busy} onClick={() => workspace && void execute(() => removeTeamspaceMemberRemote(workspace.id, selected.id, membership.id), t("teamspaceDialog:notice.memberRemoved")).then((ok) => {
                            if (ok) void refreshManagement();
                          })}>{t("teamspaceDialog:remove")}</button>
                        </div>
                      ))}
                      {membersCursor ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void loadMoreMembers()}>{t("teamspaceDialog:loadMore")}</button> : null}
                    </section>
                    <section className={styles.panel}>
                      <h3>{t("teamspaceDialog:requests")}</h3>
                      {requests.length === 0 ? <p className={styles.muted}>{t("teamspaceDialog:noRequests")}</p> : null}
                      {requests.map((request) => (
                        <div key={request.id} className={styles.memberRow}>
                          <span>{requestLabel(request)}</span>
                          <button type="button" className={styles.primary} disabled={busy} onClick={() => workspace && void execute(() => respondTeamspaceRequestRemote(workspace.id, selected.id, request.userId, "approve"), t("teamspaceDialog:notice.approved")).then((ok) => {
                            if (ok) void refreshManagement();
                          })}>{t("teamspaceDialog:approve")}</button>
                          <button type="button" className={styles.secondary} disabled={busy} onClick={() => workspace && void execute(() => respondTeamspaceRequestRemote(workspace.id, selected.id, request.userId, "deny"), t("teamspaceDialog:notice.denied")).then((ok) => {
                            if (ok) void refreshManagement();
                          })}>{t("teamspaceDialog:deny")}</button>
                        </div>
                      ))}
                      {requestsCursor ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void loadMoreRequests()}>{t("teamspaceDialog:loadMore")}</button> : null}
                    </section>
                    <section className={styles.panel}>
                      <h3>{t("teamspaceDialog:governance")}</h3>
                      {workspaceAdmin ? <label className={styles.check}><input type="checkbox" checked={teamspaceSettings?.ownersOnlyCreate === true} disabled={busy} onChange={(event) => workspace && void execute(() => updateTeamspaceSettingsRemote(workspace.id, event.target.checked), t("teamspaceDialog:notice.policySaved"))} />{t("teamspaceDialog:ownersOnlyCreate")}</label> : null}
                      {workspaceAdmin && !selected.isDefault ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => workspace && void execute(() => setDefaultTeamspaceRemote(workspace.id, selected.id), t("teamspaceDialog:notice.defaultSet"))}>{t("teamspaceDialog:setDefault")}</button> : null}
                      {selected.isDefault ? <select value={replacementDefaultId} onChange={(event) => setReplacementDefaultId(event.target.value)}><option value="">{t("teamspaceDialog:replacement")}</option>{teamspaces.filter((teamspace) => teamspace.id !== selected.id).map((teamspace) => <option key={teamspace.id} value={teamspace.id}>{teamspace.name}</option>)}</select> : null}
                      <button type="button" className={styles.danger} disabled={busy || selected.isDefault && !replacementDefaultId} onClick={() => workspace && void execute(() => archiveTeamspaceRemote(workspace.id, selected.id, replacementDefaultId || undefined), t("teamspaceDialog:notice.archived")).then((ok) => { if (ok) { setSelectedId(""); setView("browse"); } })}>{t("teamspaceDialog:archive")}</button>
                    </section>
                  </>
                ) : <p className={styles.muted}>{t("teamspaceDialog:notOwner")}</p>}
              </div>
            ) : <p className={styles.muted}>{t("teamspaceDialog:noneJoined")}</p>
          ) : null}

          {view === "archived" ? (
            <div className={styles.stack}>
              {archived.length === 0 ? <p className={styles.muted}>{t("teamspaceDialog:noneArchived")}</p> : null}
              {archived.map((teamspace) => (
                <div key={teamspace.id} className={styles.teamspaceRow}>
                  <span className={styles.icon}>{teamspace.icon || "🧭"}</span>
                  <span className={styles.rowBody}><strong>{teamspace.name}</strong><small>{teamspace.description}</small></span>
                  <button type="button" className={styles.secondary} disabled={busy} onClick={() => workspace && void execute(() => restoreTeamspaceRemote(workspace.id, teamspace.id), t("teamspaceDialog:notice.restored")).then((ok) => { if (ok) setArchived((current) => current.filter((item) => item.id !== teamspace.id)); })}>{t("teamspaceDialog:restore")}</button>
                </div>
              ))}
              {archivedCursor ? <button type="button" className={styles.secondary} disabled={busy} onClick={() => void loadMoreArchived()}>{t("teamspaceDialog:loadMore")}</button> : null}
            </div>
          ) : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
        </div>
      </section>
    </div>
  );

  return embedded || typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
