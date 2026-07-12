import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomConnectionState, RoomMember, RoomSignalMeta, Subscription } from "@edge-base/web";
import { ensureAuth, getClient } from "./edgebase";
import { i18next } from "@/i18n";
import { useStore } from "./store";
import {
  sanitizeTextSpanOperation,
  sanitizeTextSpans,
  type TextSpanOperation,
} from "./textOperations";
import {
  PAGE_ROOM_MUTATION_EVENT,
  PAGE_ROOM_MUTATION_RECEIVED_EVENT,
  PAGE_ROOM_MUTATION_SIGNAL,
  type PageRoomMutationChange,
  type PageRoomMutationReceived,
} from "./pageRoomEvents";
import {
  spansToPlainText,
  type CollaborationCrdtUpdateOperation,
  type TextSpan,
  type WorkspaceMember,
} from "./types";

const PAGE_PRESENCE_NAMESPACE = "page-presence";
const PAGE_AWARENESS_SIGNAL = "page_awareness";
const PAGE_TEXT_UPDATE_SIGNAL = "page_text_update";
const PAGE_CRDT_UPDATE_SIGNAL = "page_crdt_update";
const PAGE_AWARENESS_EVENT = "hanji:page-presence-awareness";
const PAGE_TEXT_UPDATE_EVENT = "hanji:page-text-update";
const PAGE_CRDT_UPDATE_EVENT = "hanji:page-crdt-update";
export const PAGE_TEXT_UPDATE_RECEIVED_EVENT = "hanji:page-text-update-received";
export const PAGE_CRDT_UPDATE_RECEIVED_EVENT = "hanji:page-crdt-update-received";
const PRESENCE_HEARTBEAT_MS = 25_000;
const AWARENESS_TTL_MS = 15_000;
const AWARENESS_SEND_THROTTLE_MS = 180;
const TEXT_UPDATE_SEND_DEBOUNCE_MS = 90;
const MAX_PENDING_TEXT_UPDATES = 200;
const MAX_PENDING_CRDT_UPDATES = 200;

export interface PagePresencePeer {
  memberId: string;
  userId: string;
  label: string;
  color: string;
  updatedAt?: string;
  isCurrent: boolean;
}

export type PageAwarenessMode = "editing" | "selecting" | "idle";

export interface PageAwarenessTextRange {
  end: number;
  start: number;
}

export interface PageAwarenessChange {
  blockId?: string | null;
  mode: PageAwarenessMode;
  pageId: string;
  selectedBlockIds?: string[];
  textRange?: PageAwarenessTextRange;
}

export interface PagePresenceAwareness {
  blockId?: string;
  color: string;
  label: string;
  memberId?: string;
  mode: Exclude<PageAwarenessMode, "idle">;
  selectedBlockIds: string[];
  textRange?: PageAwarenessTextRange;
  updatedAt: number;
  userId: string;
}

export interface PageTextUpdateChange {
  blockId: string;
  content: { rich: TextSpan[] };
  operation?: TextSpanOperation;
  pageId: string;
  plainText?: string;
  revision?: number;
  updatedAt?: string;
}

export interface PageTextUpdateReceived extends PageTextUpdateChange {
  color?: string;
  label?: string;
  memberId?: string;
  plainText: string;
  receivedAt: number;
  userId: string;
}

export interface PageCrdtUpdateChange {
  blockId: string;
  operation: CollaborationCrdtUpdateOperation;
  pageId: string;
  revision?: number;
  updatedAt?: string;
}

export interface PageCrdtUpdateReceived extends PageCrdtUpdateChange {
  color?: string;
  label?: string;
  memberId?: string;
  receivedAt: number;
  userId: string;
}

type AwarenessEvent = CustomEvent<PageAwarenessChange>;
type TextUpdateEvent = CustomEvent<PageTextUpdateChange>;
type CrdtUpdateEvent = CustomEvent<PageCrdtUpdateChange>;
type RoomMutationEvent = CustomEvent<PageRoomMutationChange>;

export function publishPageAwareness(change: PageAwarenessChange) {
  window.dispatchEvent(new CustomEvent(PAGE_AWARENESS_EVENT, { detail: change }));
}

export function publishPageTextUpdate(change: PageTextUpdateChange) {
  window.dispatchEvent(new CustomEvent(PAGE_TEXT_UPDATE_EVENT, { detail: change }));
}

export function publishPageCrdtUpdate(change: PageCrdtUpdateChange) {
  window.dispatchEvent(new CustomEvent(PAGE_CRDT_UPDATE_EVENT, { detail: change }));
}

function colorForUser(userId: string) {
  const colors = ["#d9730d", "#0f7b6c", "#337ea9", "#9065b0", "#c14c8a", "#548164"];
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return colors[hash % colors.length];
}

// Fallback identity for collaborators we can't resolve to a display name:
// a localized "Guest" (plus the peer's stable color) reads far better than
// leaking raw user-id hex like "User A1B2...".
function guestLabel() {
  return i18next.t("pagePresence:guest");
}

function workspaceMemberLabel(members: WorkspaceMember[], userId: string) {
  const member = members.find((candidate) => candidate.userId === userId);
  return member?.displayName?.trim() || member?.email?.trim() || "";
}

// Prefer authoritative workspace-member identity, then any display label the
// peer carried on the wire (room member state / signal payloads), and only
// then the anonymous localized guest fallback.
function presenceLabelForUser(members: WorkspaceMember[], userId: string, fallback?: string) {
  return workspaceMemberLabel(members, userId) || fallback?.trim() || guestLabel();
}

function peerFromMember(
  member: RoomMember,
  currentUserId?: string,
  workspaceMembers: WorkspaceMember[] = [],
): PagePresencePeer {
  const stateLabel = typeof member.state.label === "string" ? member.state.label : undefined;
  const label = presenceLabelForUser(workspaceMembers, member.userId, stateLabel);
  const color = typeof member.state.color === "string" ? member.state.color : colorForUser(member.userId);
  const updatedAt = typeof member.state.updatedAt === "string" ? member.state.updatedAt : undefined;
  return {
    memberId: member.memberId,
    userId: member.userId,
    label,
    color,
    updatedAt,
    isCurrent: !!currentUserId && member.userId === currentUserId,
  };
}

function sortPeers(peers: PagePresencePeer[]) {
  return peers
    .slice()
    .sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.label.localeCompare(b.label));
}

function awarenessKey(meta: RoomSignalMeta, fallbackUserId?: string) {
  return meta.memberId ?? meta.userId ?? fallbackUserId ?? "";
}

function memberForSignal(roomMembers: RoomMember[], meta: RoomSignalMeta, userId: string) {
  return roomMembers.find((member) => {
    if (meta.memberId && member.memberId === meta.memberId) return true;
    if (meta.userId && member.userId === meta.userId) return true;
    return member.userId === userId;
  });
}

function isAwarenessMode(value: unknown): value is PageAwarenessMode {
  return value === "editing" || value === "selecting" || value === "idle";
}

function cleanBlockIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.length > 0)
    .slice(0, 20);
}

function cleanTextRange(value: unknown): PageAwarenessTextRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.start !== "number" || typeof source.end !== "number") return undefined;
  if (!Number.isFinite(source.start) || !Number.isFinite(source.end)) return undefined;
  const start = Math.max(0, Math.floor(source.start));
  const end = Math.max(0, Math.floor(source.end));
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function cleanCrdtUpdateOperation(value: unknown): CollaborationCrdtUpdateOperation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.engine !== "yjs") return undefined;
  if (typeof source.updateBase64 !== "string" || !source.updateBase64.trim()) return undefined;
  if (typeof source.documentId !== "string" || !source.documentId.trim()) return undefined;
  return {
    engine: "yjs",
    schemaVersion:
      typeof source.schemaVersion === "number" && Number.isFinite(source.schemaVersion)
        ? Math.max(1, Math.floor(source.schemaVersion))
        : 1,
    documentId: source.documentId.trim(),
    updateBase64: source.updateBase64.trim(),
    stateVectorBase64:
      typeof source.stateVectorBase64 === "string" && source.stateVectorBase64.trim()
        ? source.stateVectorBase64.trim()
        : undefined,
    originClientId:
      typeof source.originClientId === "string" && source.originClientId.trim()
        ? source.originClientId.trim()
        : undefined,
  };
}

function cleanStringArray(value: unknown, limit = 100) {
  if (!Array.isArray(value)) return undefined;
  const cleaned = value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, limit);
  return cleaned.length > 0 ? cleaned : undefined;
}

function cleanPageMutationKind(value: unknown): PageRoomMutationChange["kind"] | undefined {
  return value === "page_meta_changed" ||
    value === "database_rows_changed" ||
    value === "database_schema_changed" ||
    value === "database_views_changed" ||
    value === "database_templates_changed" ||
    value === "block_structure_changed" ||
    value === "comments_changed" ||
    value === "permissions_changed"
    ? value
    : undefined;
}

function cleanPageMutationPayload(value: unknown, pageId: string): PageRoomMutationChange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  if (source.pageId !== pageId) return undefined;
  const kind = cleanPageMutationKind(source.kind);
  if (!kind) return undefined;
  const patch = source.patch && typeof source.patch === "object" ? source.patch as PageRoomMutationChange["patch"] : undefined;
  return {
    blockIds: cleanStringArray(source.blockIds),
    databaseId: typeof source.databaseId === "string" ? source.databaseId : undefined,
    kind,
    pageId,
    patch,
    propertyIds: cleanStringArray(source.propertyIds),
    reason: typeof source.reason === "string" ? source.reason : undefined,
    revision: typeof source.revision === "number" && Number.isFinite(source.revision) ? source.revision : undefined,
    rowIds: cleanStringArray(source.rowIds),
    targetPageId: typeof source.targetPageId === "string" ? source.targetPageId : undefined,
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
    viewIds: cleanStringArray(source.viewIds),
  };
}

export function usePagePresence(pageId: string, enabled: boolean) {
  const workspaceId = useStore((s) => s.workspace?.id);
  const storedUserId = useStore((s) => s.userId);
  const workspaceMembers = useStore((s) => s.workspaceMembers);
  // The join effect must NOT tear down and re-join the room when the member
  // list merely refreshes (the workspace delta poll can replace the array
  // identity); handlers read the latest members through this ref instead.
  const workspaceMembersRef = useRef(workspaceMembers);
  useEffect(() => {
    workspaceMembersRef.current = workspaceMembers;
  });
  const [currentUserId, setCurrentUserId] = useState<string | undefined>(storedUserId);
  const [status, setStatus] = useState<RoomConnectionState>("idle");
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [awarenessByMember, setAwarenessByMember] = useState<Record<string, PagePresenceAwareness>>({});
  const [lastError, setLastError] = useState<string | undefined>();

  useEffect(() => {
    if (!enabled || !pageId || !workspaceId) {
      setStatus("idle");
      setMembers([]);
      setAwarenessByMember({});
      setCurrentUserId(storedUserId);
      setLastError(undefined);
      return;
    }

    let cancelled = false;
    let heartbeat: number | undefined;
    let awarenessCleanup: number | undefined;
    let lastAwarenessSentAt = 0;
    let activeUserId = storedUserId || "";
    const pendingTextUpdates: PageTextUpdateChange[] = [];
    const pendingCrdtUpdates: PageCrdtUpdateChange[] = [];
    const queuedTextUpdates = new Map<string, PageTextUpdateChange>();
    const textUpdateTimers = new Map<string, number>();
    const room = getClient().room(PAGE_PRESENCE_NAMESPACE, pageId, {
      maxReconnectAttempts: 8,
      heartbeatIntervalMs: 8000,
    });
    const subscriptions: Subscription[] = [];

    function syncMembers() {
      const nextMembers = room.members.list();
      const activeKeys = new Set(
        nextMembers.flatMap((member) => [member.memberId, member.userId].filter(Boolean)),
      );
      setMembers(nextMembers);
      setAwarenessByMember((current) =>
        Object.fromEntries(
          Object.entries(current).filter(
            ([key, awareness]) => activeKeys.has(key) || activeKeys.has(awareness.userId),
          ),
        ),
      );
    }

    async function publishState(userId: string) {
      await room.members.setState({
        pageId,
        workspaceId,
        label: presenceLabelForUser(workspaceMembersRef.current, userId),
        color: colorForUser(userId),
        updatedAt: new Date().toISOString(),
      });
    }

    function pruneAwareness() {
      const cutoff = Date.now() - AWARENESS_TTL_MS;
      setAwarenessByMember((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([, awareness]) => awareness.updatedAt >= cutoff),
        ),
      );
    }

    function receiveAwareness(payload: unknown, meta: RoomSignalMeta) {
      if (!payload || typeof payload !== "object") return;
      const source = payload as Record<string, unknown>;
      if (source.pageId !== pageId) return;
      const userId =
        typeof source.userId === "string"
          ? source.userId
          : typeof meta.userId === "string"
            ? meta.userId
            : "";
      if (!userId || userId === activeUserId) return;
      const key = awarenessKey(meta, userId);
      if (!key) return;
      const mode = source.mode;
      if (!isAwarenessMode(mode)) return;
      if (mode === "idle") {
        setAwarenessByMember((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        return;
      }

      const roomMembers = room.members.list();
      const member = memberForSignal(roomMembers, meta, userId);
      const label =
        presenceLabelForUser(
          workspaceMembersRef.current,
          userId,
          typeof source.label === "string"
            ? source.label
            : member
              ? peerFromMember(member, activeUserId, workspaceMembersRef.current).label
              : undefined,
        );
      const color =
        typeof source.color === "string"
          ? source.color
          : member
            ? peerFromMember(member, activeUserId, workspaceMembersRef.current).color
            : colorForUser(userId);
      const blockId = typeof source.blockId === "string" ? source.blockId : undefined;
      setAwarenessByMember((current) => ({
        ...current,
        [key]: {
          blockId,
          color,
          label,
          memberId: meta.memberId ?? member?.memberId ?? undefined,
          mode,
          selectedBlockIds: cleanBlockIds(source.selectedBlockIds),
          textRange: cleanTextRange(source.textRange),
          updatedAt: Date.now(),
          userId,
        },
      }));
    }

    function receiveTextUpdate(payload: unknown, meta: RoomSignalMeta) {
      if (!payload || typeof payload !== "object") return;
      const source = payload as Record<string, unknown>;
      if (source.pageId !== pageId || typeof source.blockId !== "string") return;
      const userId =
        typeof source.userId === "string"
          ? source.userId
          : typeof meta.userId === "string"
            ? meta.userId
            : "";
      if (!userId || userId === activeUserId) return;
      const contentSource =
        source.content && typeof source.content === "object"
          ? (source.content as Record<string, unknown>)
          : undefined;
      const rich = sanitizeTextSpans(contentSource?.rich);
      if (!rich) return;
      const roomMembers = room.members.list();
      const member = memberForSignal(roomMembers, meta, userId);
      const plainText =
        typeof source.plainText === "string" ? source.plainText : spansToPlainText(rich);
      const updatedAt = typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString();
      const revision = typeof source.revision === "number" ? source.revision : undefined;
      const operation = sanitizeTextSpanOperation(source.operation);
      window.dispatchEvent(
        new CustomEvent<PageTextUpdateReceived>(PAGE_TEXT_UPDATE_RECEIVED_EVENT, {
          detail: {
            blockId: source.blockId,
            color: typeof source.color === "string" ? source.color : undefined,
            content: { rich },
            label: typeof source.label === "string" ? source.label : undefined,
            memberId: meta.memberId ?? member?.memberId ?? undefined,
            operation,
            pageId,
            plainText,
            receivedAt: Date.now(),
            revision,
            updatedAt,
            userId,
          },
        }),
      );
    }

    function receiveCrdtUpdate(payload: unknown, meta: RoomSignalMeta) {
      if (!payload || typeof payload !== "object") return;
      const source = payload as Record<string, unknown>;
      if (source.pageId !== pageId || typeof source.blockId !== "string") return;
      const userId =
        typeof source.userId === "string"
          ? source.userId
          : typeof meta.userId === "string"
            ? meta.userId
            : "";
      if (!userId || userId === activeUserId) return;
      const operation = cleanCrdtUpdateOperation(source.operation);
      if (!operation) return;
      const roomMembers = room.members.list();
      const member = memberForSignal(roomMembers, meta, userId);
      window.dispatchEvent(
        new CustomEvent<PageCrdtUpdateReceived>(PAGE_CRDT_UPDATE_RECEIVED_EVENT, {
          detail: {
            blockId: source.blockId,
            color: typeof source.color === "string" ? source.color : undefined,
            label: typeof source.label === "string" ? source.label : undefined,
            memberId: meta.memberId ?? member?.memberId ?? undefined,
            operation,
            pageId,
            receivedAt: Date.now(),
            revision: typeof source.revision === "number" ? source.revision : undefined,
            updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : undefined,
            userId,
          },
        }),
      );
    }

    function receivePageMutation(payload: unknown, meta: RoomSignalMeta) {
      const clean = cleanPageMutationPayload(payload, pageId);
      if (!clean) return;
      const userId =
        typeof (payload as Record<string, unknown>).userId === "string"
          ? String((payload as Record<string, unknown>).userId)
          : typeof meta.userId === "string"
            ? meta.userId
            : "";
      if (!userId || userId === activeUserId) return;
      const roomMembers = room.members.list();
      const member = memberForSignal(roomMembers, meta, userId);
      const label =
        typeof (payload as Record<string, unknown>).label === "string"
          ? String((payload as Record<string, unknown>).label)
          : member
            ? peerFromMember(member, activeUserId, workspaceMembersRef.current).label
            : presenceLabelForUser(workspaceMembersRef.current, userId);
      window.dispatchEvent(
        new CustomEvent<PageRoomMutationReceived>(PAGE_ROOM_MUTATION_RECEIVED_EVENT, {
          detail: {
            ...clean,
            label,
            memberId: meta.memberId ?? member?.memberId ?? undefined,
            receivedAt: Date.now(),
            userId,
          },
        }),
      );
    }

    function publishAwareness(event: Event) {
      const detail = (event as AwarenessEvent).detail;
      if (!detail || detail.pageId !== pageId) return;
      const now = Date.now();
      if (detail.mode !== "idle" && now - lastAwarenessSentAt < AWARENESS_SEND_THROTTLE_MS) return;
      lastAwarenessSentAt = now;
      if (!activeUserId || room.getConnectionState() !== "connected") return;
      void room.signals
        .send(PAGE_AWARENESS_SIGNAL, {
          ...detail,
          color: colorForUser(activeUserId),
          label: presenceLabelForUser(workspaceMembersRef.current, activeUserId),
          selectedBlockIds: detail.selectedBlockIds?.slice(0, 20),
          textRange: cleanTextRange(detail.textRange),
          updatedAt: now,
          userId: activeUserId,
        })
        .catch(() => {});
    }

    function queueTextUpdate(detail: PageTextUpdateChange) {
      pendingTextUpdates.push(detail);
      if (pendingTextUpdates.length > MAX_PENDING_TEXT_UPDATES) pendingTextUpdates.shift();
    }

    function queueCrdtUpdate(detail: PageCrdtUpdateChange) {
      pendingCrdtUpdates.push(detail);
      if (pendingCrdtUpdates.length > MAX_PENDING_CRDT_UPDATES) pendingCrdtUpdates.shift();
    }

    function sendTextUpdateNow(detail: PageTextUpdateChange) {
      if (!activeUserId || room.getConnectionState() !== "connected") return false;
      const rich = sanitizeTextSpans(detail.content?.rich);
      if (!rich) return true;
      const operation = sanitizeTextSpanOperation(detail.operation);
      const plainText =
        typeof detail.plainText === "string" ? detail.plainText : spansToPlainText(rich);
      const now = Date.now();
      void room.signals
        .send(PAGE_TEXT_UPDATE_SIGNAL, {
          blockId: detail.blockId,
          color: colorForUser(activeUserId),
          content: { rich },
          label: presenceLabelForUser(workspaceMembersRef.current, activeUserId),
          operation,
          pageId,
          plainText,
          revision: typeof detail.revision === "number" ? detail.revision : now,
          updatedAt: detail.updatedAt ?? new Date().toISOString(),
          userId: activeUserId,
        })
        .catch(() => {});
      return true;
    }

    function flushPendingTextUpdates() {
      if (!activeUserId || room.getConnectionState() !== "connected") return;
      while (pendingTextUpdates.length) {
        const detail = pendingTextUpdates.shift();
        if (detail && !sendTextUpdateNow(detail)) {
          queueTextUpdate(detail);
          break;
        }
      }
    }

    function sendCrdtUpdateNow(detail: PageCrdtUpdateChange) {
      if (!activeUserId || room.getConnectionState() !== "connected") return false;
      const operation = cleanCrdtUpdateOperation(detail.operation);
      if (!operation) return true;
      const now = Date.now();
      void room.signals
        .send(PAGE_CRDT_UPDATE_SIGNAL, {
          blockId: detail.blockId,
          color: colorForUser(activeUserId),
          label: presenceLabelForUser(workspaceMembersRef.current, activeUserId),
          operation,
          pageId,
          revision: typeof detail.revision === "number" ? detail.revision : now,
          updatedAt: detail.updatedAt ?? new Date().toISOString(),
          userId: activeUserId,
        })
        .catch(() => {});
      return true;
    }

    function flushPendingCrdtUpdates() {
      if (!activeUserId || room.getConnectionState() !== "connected") return;
      while (pendingCrdtUpdates.length) {
        const detail = pendingCrdtUpdates.shift();
        if (detail && !sendCrdtUpdateNow(detail)) {
          queueCrdtUpdate(detail);
          break;
        }
      }
    }

    function sendTextUpdate(detail: PageTextUpdateChange) {
      if (!sendTextUpdateNow(detail)) queueTextUpdate(detail);
    }

    function sendQueuedTextUpdate(blockId: string) {
      const timer = textUpdateTimers.get(blockId);
      if (timer) window.clearTimeout(timer);
      textUpdateTimers.delete(blockId);
      const detail = queuedTextUpdates.get(blockId);
      queuedTextUpdates.delete(blockId);
      if (!detail) return;
      sendTextUpdate(detail);
    }

    function publishTextUpdate(event: Event) {
      const detail = (event as TextUpdateEvent).detail;
      if (!detail || detail.pageId !== pageId || !detail.blockId) return;
      if (detail.operation) {
        sendTextUpdate(detail);
        return;
      }
      queuedTextUpdates.set(detail.blockId, detail);
      const timer = textUpdateTimers.get(detail.blockId);
      if (timer) window.clearTimeout(timer);
      textUpdateTimers.set(
        detail.blockId,
        window.setTimeout(() => sendQueuedTextUpdate(detail.blockId), TEXT_UPDATE_SEND_DEBOUNCE_MS),
      );
    }

    function publishCrdtUpdate(event: Event) {
      const detail = (event as CrdtUpdateEvent).detail;
      if (!detail || detail.pageId !== pageId || !detail.blockId) return;
      if (!sendCrdtUpdateNow(detail)) queueCrdtUpdate(detail);
    }

    function publishPageMutation(event: Event) {
      const detail = (event as RoomMutationEvent).detail;
      const clean = cleanPageMutationPayload(detail, pageId);
      if (!clean) return;
      if (!activeUserId || room.getConnectionState() !== "connected") return;
      const now = Date.now();
      void room.signals
        .send(PAGE_ROOM_MUTATION_SIGNAL, {
          ...clean,
          color: colorForUser(activeUserId),
          label: presenceLabelForUser(workspaceMembersRef.current, activeUserId),
          revision: clean.revision ?? now,
          updatedAt: clean.updatedAt ?? new Date().toISOString(),
          userId: activeUserId,
        })
        .catch(() => {});
    }

    async function connect() {
      try {
        setLastError(undefined);
        const userId = storedUserId || (await ensureAuth());
        if (cancelled) return;
        activeUserId = userId;
        setCurrentUserId(userId || undefined);
        subscriptions.push(room.session.onError((error) => {
          setLastError(`${error.code || "ROOM_ERROR"}: ${error.message || "Room error"}`);
        }));
        subscriptions.push(room.session.onConnectionStateChange((state) => {
          setStatus(state);
          if (state === "connected") {
            flushPendingTextUpdates();
            flushPendingCrdtUpdates();
          }
        }));
        subscriptions.push(room.members.onSync(syncMembers));
        subscriptions.push(room.members.onJoin(syncMembers));
        subscriptions.push(room.members.onLeave(syncMembers));
        subscriptions.push(room.members.onStateChange(syncMembers));
        subscriptions.push(room.signals.on(PAGE_AWARENESS_SIGNAL, receiveAwareness));
        subscriptions.push(room.signals.on(PAGE_TEXT_UPDATE_SIGNAL, receiveTextUpdate));
        subscriptions.push(room.signals.on(PAGE_CRDT_UPDATE_SIGNAL, receiveCrdtUpdate));
        subscriptions.push(room.signals.on(PAGE_ROOM_MUTATION_SIGNAL, receivePageMutation));
        window.addEventListener(PAGE_AWARENESS_EVENT, publishAwareness);
        window.addEventListener(PAGE_TEXT_UPDATE_EVENT, publishTextUpdate);
        window.addEventListener(PAGE_CRDT_UPDATE_EVENT, publishCrdtUpdate);
        window.addEventListener(PAGE_ROOM_MUTATION_EVENT, publishPageMutation);
        setStatus(room.getConnectionState());
        await room.join();
        if (cancelled) return;
        await publishState(userId);
        syncMembers();
        flushPendingTextUpdates();
        flushPendingCrdtUpdates();
        heartbeat = window.setInterval(() => {
          void publishState(userId).catch(() => {});
        }, PRESENCE_HEARTBEAT_MS);
        awarenessCleanup = window.setInterval(pruneAwareness, 5_000);
      } catch (error) {
        if (!cancelled) {
          setLastError(error instanceof Error ? error.message : String(error));
          setStatus("disconnected");
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      if (heartbeat) window.clearInterval(heartbeat);
      if (awarenessCleanup) window.clearInterval(awarenessCleanup);
      for (const timer of textUpdateTimers.values()) window.clearTimeout(timer);
      window.removeEventListener(PAGE_AWARENESS_EVENT, publishAwareness);
      window.removeEventListener(PAGE_TEXT_UPDATE_EVENT, publishTextUpdate);
      window.removeEventListener(PAGE_CRDT_UPDATE_EVENT, publishCrdtUpdate);
      window.removeEventListener(PAGE_ROOM_MUTATION_EVENT, publishPageMutation);
      for (const subscription of subscriptions) subscription.unsubscribe();
      room.leave();
    };
  }, [enabled, pageId, storedUserId, workspaceId]);

  const peers = useMemo(
    () =>
      sortPeers(
        members
          // connectionCount 0 = the server is holding the member in its
          // reconnect-grace window (tab closed, TTL not expired). They're not
          // present — counting them as "connected" shows ghost collaborators.
          .filter((member) => member.connectionCount !== 0)
          .map((member) => peerFromMember(member, currentUserId, workspaceMembers)),
      ),
    [currentUserId, members, workspaceMembers],
  );
  const awareness = useMemo(
    () => Object.values(awarenessByMember).sort((a, b) => b.updatedAt - a.updatedAt),
    [awarenessByMember],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("hanji.debugPresence") !== "1") return;
    (
      window as Window & {
        __hanjiPresenceDebug?: unknown;
      }
    ).__hanjiPresenceDebug = {
      activeCount: peers.length,
      awarenessCount: awareness.length,
      currentUserId,
      enabled,
      members: members.map((member) => ({
        memberId: member.memberId,
        state: member.state,
        userId: member.userId,
      })),
      lastError,
      pageId,
      peers,
      status,
      workspaceId,
    };
  }, [awareness, currentUserId, enabled, lastError, members, pageId, peers, status, workspaceId]);

  return {
    status,
    peers,
    activeCount: peers.length,
    awareness,
  };
}
