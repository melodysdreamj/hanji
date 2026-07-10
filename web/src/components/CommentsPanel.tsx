"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { searchOrganizationPeopleRemote } from "@/lib/edgebase";
import { isComposingKeyEvent } from "@/lib/keyboard";
import { motionSafeScrollBehavior } from "@/lib/motion";
import type { Comment, OrganizationProfile, TextSpan } from "@/lib/types";
import { useStore } from "@/lib/store";
import { canCommentPage, canEditPage } from "@/lib/permissions";
import { activeDateLocale, pickLabels } from "@/lib/i18n";
import { concatSpans, splitSpans } from "./editor/richtext";
import { actorLabel, personLabel } from "./database/people";
import { X } from "./icons";
import styles from "./CommentsPanel.module.css";

const COMMENTS_PANEL_LABELS = {
  en: {
    addBlockComment: "Add a block comment",
    addPageComment: "Add a page comment",
    blockCommentPlaceholder: "Comment on this block...",
    blockDiscussion: "Block discussion",
    cancel: "Cancel",
    closeComments: "Close comments",
    comment: "Comment",
    commentAria: (author: string, time: string, resolved: boolean) =>
      `${author} comment, ${time}${resolved ? ", resolved" : ""}`,
    commentMentionPeople: "Comment mention people",
    commentStatus: "Comment status",
    commentThreads: "Comment threads",
    commentingOn: "Commenting on",
    commentingOnSelectedText: "Commenting on selected text",
    comments: "Comments",
    delete: "Delete",
    deleteCommentConfirm: "Delete this comment?",
    deleteThreadConfirm: (replyCount: number) =>
      `Delete this comment and its ${replyCount === 1 ? "reply" : `${replyCount} replies`}?`,
    edit: "Edit",
    editComment: "Edit comment",
    emptyComment: "(empty comment)",
    emptyReply: "(empty reply)",
    justNow: "Just now",
    mentionPeople: "Mention people",
    mentionTitle: (name: string) => `Mention ${name}`,
    noCommentsYet: "No comments yet",
    noMatchingPeople: "No matching people",
    noOpenComments: "No open comments",
    noResolvedComments: "No resolved comments",
    onABlock: "On a block",
    onSelectedBlock: "On selected block",
    edited: "(edited)",
    onSelectedText: "On selected text",
    open: "Open",
    organizationPerson: "Organization person",
    pageCommentPlaceholder: "Add a comment...",
    pageDiscussion: "Page discussion",
    person: "Person",
    reopen: "Reopen",
    repliesAria: (count: number) => `${count} replies`,
    reply: "Reply",
    replyAria: (author: string, time: string) => `${author} reply, ${time}`,
    replyMentionPeople: "Reply mention people",
    replyPlaceholder: "Reply...",
    resolve: "Resolve",
    resolved: "Resolved",
    roleInOrganization: (role: string) => `${role} in organization`,
    save: "Save",
    selectedBlock: "Selected block",
    showInPage: "Show in page",
    you: "You",
  },
  ko: {
    addBlockComment: "블록 댓글 추가",
    addPageComment: "페이지 댓글 추가",
    blockCommentPlaceholder: "이 블록에 댓글 남기기...",
    blockDiscussion: "블록 토론",
    cancel: "취소",
    closeComments: "댓글 닫기",
    comment: "댓글 달기",
    commentAria: (author: string, time: string, resolved: boolean) =>
      `${author}님의 댓글, ${time}${resolved ? ", 해결됨" : ""}`,
    commentMentionPeople: "댓글에서 멘션할 사람",
    commentStatus: "댓글 상태",
    commentThreads: "댓글 스레드",
    commentingOn: "댓글 대상",
    commentingOnSelectedText: "선택한 텍스트에 댓글 남기기",
    comments: "댓글",
    delete: "삭제",
    deleteCommentConfirm: "이 댓글을 삭제할까요?",
    deleteThreadConfirm: (replyCount: number) =>
      `이 댓글과 답글 ${replyCount}개를 함께 삭제할까요?`,
    edit: "수정",
    editComment: "댓글 수정",
    emptyComment: "(빈 댓글)",
    emptyReply: "(빈 답글)",
    justNow: "방금 전",
    mentionPeople: "사람 멘션",
    mentionTitle: (name: string) => `${name}님 멘션`,
    noCommentsYet: "아직 댓글이 없어요",
    noMatchingPeople: "일치하는 사람이 없어요",
    noOpenComments: "열린 댓글이 없어요",
    noResolvedComments: "해결된 댓글이 없어요",
    onABlock: "블록에 남긴 댓글",
    onSelectedBlock: "선택한 블록에 남긴 댓글",
    edited: "(수정됨)",
    onSelectedText: "선택한 텍스트에 남긴 댓글",
    open: "열림",
    organizationPerson: "조직 구성원",
    pageCommentPlaceholder: "댓글 추가...",
    pageDiscussion: "페이지 토론",
    person: "사람",
    reopen: "다시 열기",
    repliesAria: (count: number) => `답글 ${count}개`,
    reply: "답글",
    replyAria: (author: string, time: string) => `${author}님의 답글, ${time}`,
    replyMentionPeople: "답글에서 멘션할 사람",
    replyPlaceholder: "답글 입력...",
    resolve: "해결",
    resolved: "해결됨",
    roleInOrganization: (role: string) => `조직 내 ${role}`,
    save: "저장",
    selectedBlock: "선택한 블록",
    showInPage: "페이지에서 보기",
    you: "나",
  },
} as const;

// Locale cannot change mid-session (matches WorkspaceSettingsDialog's LABELS
// convention), so resolve the dictionary once at module load.
const LABELS = pickLabels(COMMENTS_PANEL_LABELS);

function richTextSpans(body: unknown): TextSpan[] {
  if (typeof body === "string") return body ? [{ text: body }] : [];
  const rich = (body as { rich?: TextSpan[] } | undefined)?.rich;
  if (Array.isArray(rich)) return rich.filter((span) => span && typeof span.text === "string");
  return [];
}

function renderCommentRichText(spans: TextSpan[]): ReactNode {
  return spans.map((span, index) => {
    const text = span.text ?? "";
    if (!text) return null;
    if (span.mention === "person" && span.userId?.trim()) {
      const userId = span.userId.trim();
      return (
        <span
          key={`${userId}-${index}`}
          className={styles.commentMention}
          data-comment-mention-user-id={userId}
          data-mention="person"
          title={LABELS.mentionTitle(text.replace(/^@/, ""))}
        >
          {text}
        </span>
      );
    }
    return <span key={index}>{text}</span>;
  });
}

function quoteText(body: unknown): string {
  const quote = (body as { quote?: unknown } | undefined)?.quote;
  return typeof quote === "string" ? quote.trim() : "";
}

function quoteRange(body: unknown) {
  const range = body as { quoteStart?: unknown; quoteEnd?: unknown } | undefined;
  if (typeof range?.quoteStart !== "number" || typeof range?.quoteEnd !== "number") return null;
  if (range.quoteEnd <= range.quoteStart) return null;
  return { start: range.quoteStart, end: range.quoteEnd };
}

// Body edits keep the stored body shape: the rich span array is replaced with
// the edited plain text while quote anchor fields (quote/quoteStart/quoteEnd)
// and any other metadata on the body object survive untouched.
function editedCommentBody(comment: Comment, text: string): unknown {
  const base =
    comment.body && typeof comment.body === "object"
      ? { ...(comment.body as Record<string, unknown>) }
      : {};
  const rich: TextSpan[] = [{ text }];
  return { ...base, rich };
}

function timeLabel(value?: string) {
  if (!value) return LABELS.justNow;
  return new Date(value).toLocaleString(activeDateLocale(), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function authorLabel(comment: Comment, userId?: string) {
  return actorLabel(comment.authorId, userId);
}

type CommentMentionDraft = {
  label: string;
  userId: string;
};

type CommentMentionRange = {
  start: number;
  end: number;
  query: string;
};

function commentMentionLabel(profile: OrganizationProfile) {
  return profile.displayName?.trim() || profile.email?.trim() || profile.userId?.trim() || LABELS.person;
}

function commentMentionDescription(profile: OrganizationProfile) {
  const parts = [
    profile.email?.trim(),
    profile.organizationRole ? LABELS.roleInOrganization(profile.organizationRole) : null,
    profile.status && profile.status !== "active" ? profile.status : null,
  ].filter(Boolean);
  return parts.join(" - ") || LABELS.organizationPerson;
}

function commentMentionProfile(input: {
  userId?: string | null;
  displayName?: string | null;
  email?: string | null;
  role?: string | null;
  status?: string | null;
}): OrganizationProfile | null {
  const userId = input.userId?.trim();
  if (!userId) return null;
  return {
    userId,
    displayName: input.displayName?.trim() || personLabel(userId, userId) || LABELS.you,
    email: input.email?.trim() || null,
    organizationRole: input.role?.trim() || "member",
    status: input.status?.trim() || "active",
    workspaceMemberships: [],
    pendingInvitations: [],
  };
}

function addMentionProfile(map: Map<string, OrganizationProfile>, profile: OrganizationProfile | null | undefined) {
  if (!profile) return;
  const userId = profile.userId?.trim();
  if (!userId) return;
  const existing = map.get(userId);
  map.set(userId, {
    ...profile,
    userId,
    displayName: existing?.displayName?.trim() || profile.displayName?.trim() || null,
    email: existing?.email?.trim() || profile.email?.trim() || null,
    organizationRole: existing?.organizationRole || profile.organizationRole || "member",
    status: existing?.status || profile.status || "active",
    workspaceMemberships: existing?.workspaceMemberships?.length
      ? existing.workspaceMemberships
      : profile.workspaceMemberships ?? [],
    pendingInvitations: existing?.pendingInvitations?.length
      ? existing.pendingInvitations
      : profile.pendingInvitations ?? [],
  });
}

function commentMentionTrigger(value: string, cursor: number): CommentMentionRange | null {
  const before = value.slice(0, cursor);
  const match = before.match(/(?:^|\s)@([\p{L}\p{N}_@._-]*)$/u);
  if (!match) return null;
  const query = match[1] ?? "";
  const start = cursor - query.length - 1;
  return { start, end: cursor, query };
}

function commentMentionMatches(profile: OrganizationProfile, query: string) {
  if (!query.trim()) return true;
  const label = commentMentionLabel(profile);
  const haystack = `${label} ${commentMentionDescription(profile)} ${profile.userId ?? ""}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

function commentMentionReplacement(value: string, range: CommentMentionRange, label: string) {
  const replacement = `@${label.trim()}`;
  const next = value[range.end] ?? "";
  const suffix = next && /\s/.test(next) ? "" : " ";
  return {
    cursor: range.start + replacement.length + suffix.length,
    value: `${value.slice(0, range.start)}${replacement}${suffix}${value.slice(range.end)}`,
  };
}

function mentionCueInsertion(value: string, start: number, end: number) {
  const boundedStart = Math.max(0, Math.min(start, value.length));
  const boundedEnd = Math.max(boundedStart, Math.min(end, value.length));
  const previous = value[boundedStart - 1] ?? "";
  const next = value[boundedEnd] ?? "";
  const prefix = boundedStart > 0 && previous && !/\s/.test(previous) ? " @" : "@";
  const suffix = next && !/\s/.test(next) ? " " : "";
  return {
    cursor: boundedStart + prefix.length,
    value: `${value.slice(0, boundedStart)}${prefix}${suffix}${value.slice(boundedEnd)}`,
  };
}

function isMentionBoundaryBefore(value: string, index: number) {
  if (index <= 0) return true;
  return /[\s([{"']/.test(value[index - 1] ?? "");
}

function isMentionBoundaryAfter(value: string, index: number) {
  if (index >= value.length) return true;
  return !/[\p{L}\p{N}_@-]/u.test(value[index] ?? "");
}

function commentRichWithMentions(text: string, mentions: CommentMentionDraft[]): TextSpan[] {
  const mentionCandidates = mentions
    .filter((mention) => mention.label.trim() && mention.userId.trim())
    .map((mention) => ({
      ...mention,
      needle: `@${mention.label.trim()}`,
    }))
    .sort((a, b) => b.needle.length - a.needle.length);
  const spans: TextSpan[] = [];
  let index = 0;
  while (index < text.length) {
    const match = mentionCandidates
      .map((mention) => {
        let at = text.indexOf(mention.needle, index);
        while (at >= 0) {
          const end = at + mention.needle.length;
          if (isMentionBoundaryBefore(text, at) && isMentionBoundaryAfter(text, end)) {
            return { mention, at };
          }
          at = text.indexOf(mention.needle, at + mention.needle.length);
        }
        return { mention, at: -1 };
      })
      .filter((candidate) => candidate.at >= 0)
      .sort((a, b) => a.at - b.at || b.mention.needle.length - a.mention.needle.length)[0];
    if (!match) {
      spans.push({ text: text.slice(index) });
      break;
    }
    if (match.at > index) spans.push({ text: text.slice(index, match.at) });
    spans.push({
      text: match.mention.needle,
      mention: "person",
      userId: match.mention.userId,
    });
    index = match.at + match.mention.needle.length;
  }
  return spans.length ? spans : [{ text }];
}

function addCommentAnchor(
  spans: TextSpan[],
  start: number | undefined,
  end: number | undefined,
  commentId: string
) {
  if (typeof start !== "number" || typeof end !== "number" || end <= start) return spans;
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(spansToPlainTextSafe(spans).length, end);
  if (boundedEnd <= boundedStart) return spans;
  const [before, rest] = splitSpans(spans, boundedStart);
  const [selected, after] = splitSpans(rest, boundedEnd - boundedStart);
  const anchored = selected.map((span) => ({ ...span, commentId }));
  return concatSpans(concatSpans(before, anchored), after);
}

function removeCommentAnchor(spans: TextSpan[], commentId: string) {
  let changed = false;
  const next = spans.map((span) => {
    if (span.commentId !== commentId) return span;
    changed = true;
    const nextSpan = { ...span };
    delete nextSpan.commentId;
    return nextSpan;
  });
  return changed ? concatSpans(next, []) : spans;
}

export function CommentsPanel({
  pageId,
  blockId = null,
  activeCommentId,
  initialQuote,
  initialQuoteStart,
  initialQuoteEnd,
  onClose,
}: {
  pageId: string;
  blockId?: string | null;
  activeCommentId?: string;
  initialQuote?: string;
  initialQuoteStart?: number;
  initialQuoteEnd?: number;
  onClose: () => void;
}) {
  const loadComments = useStore((s) => s.loadComments);
  const comments = useStore(useShallow((s) => s.pageComments(pageId)));
  const blocks = useStore(useShallow((s) => s.blocksByPage[pageId] ?? []));
  const targetBlock = useStore((s) =>
    blockId ? (s.blocksByPage[pageId] ?? []).find((block) => block.id === blockId) : undefined
  );
  const addComment = useStore((s) => s.addComment);
  const updateComment = useStore((s) => s.updateComment);
  const deleteComment = useStore((s) => s.deleteComment);
  const updateBlock = useStore((s) => s.updateBlock);
  const userId = useStore((s) => s.userId);
  const currentMember = useStore((s) => s.currentMember);
  const page = useStore((s) => s.pagesById[pageId]);
  const pagesById = useStore((s) => s.pagesById);
  const pageRoles = useStore((s) => s.pageRolesById);
  const workspace = useStore((s) => s.workspace);
  // Only offer compose/reply/resolve affordances when the backend will accept
  // the mutation (comment-level access or higher). View-only readers can still
  // open the panel to read existing threads.
  const canComment = canCommentPage({ page, pagesById, pageRoles, workspace, currentMember, userId });
  // Resolve/Reopen requires edit access OR authorship on the backend
  // (assertCanChangeComment) — mirror both halves so comment-only members
  // don't get a Resolve button on other people's threads that flips
  // optimistically and reverts once the server rejects it.
  const canEditThisPage = canEditPage({ page, pagesById, pageRoles, workspace, currentMember, userId });
  const workspaceMembers = useStore((s) => s.workspaceMembers);
  const organization = useStore((s) => s.organization);
  const currentOrganizationMember = useStore((s) => s.currentOrganizationMember);
  const organizationProfiles = useStore((s) => s.organizationProfiles);
  const [draft, setDraft] = useState("");
  const [draftMentionRange, setDraftMentionRange] = useState<CommentMentionRange | null>(null);
  const [draftMentionActive, setDraftMentionActive] = useState(0);
  const [draftMentions, setDraftMentions] = useState<CommentMentionDraft[]>([]);
  const [searchedPeople, setSearchedPeople] = useState<{
    key: string;
    people: OrganizationProfile[];
  }>({ key: "", people: [] });
  const [pendingQuote, setPendingQuote] = useState(initialQuote?.trim() || "");
  const [submitting, setSubmitting] = useState(false);
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyMentionRange, setReplyMentionRange] = useState<CommentMentionRange | null>(null);
  const [replyMentionActive, setReplyMentionActive] = useState(0);
  const [replyMentions, setReplyMentions] = useState<CommentMentionDraft[]>([]);
  const [replySearchedPeople, setReplySearchedPeople] = useState<{
    key: string;
    people: OrganizationProfile[];
  }>({ key: "", people: [] });
  const [submittingReply, setSubmittingReply] = useState(false);
  const [commentView, setCommentView] = useState<"open" | "resolved">("open");
  const titleId = useId();
  const listId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    onClose();
    window.requestAnimationFrame(() => {
      if (restoreFocusRef.current?.isConnected) restoreFocusRef.current.focus();
      restoreFocusRef.current = null;
    });
  }, [onClose]);

  useEffect(() => {
    void loadComments(pageId);
  }, [loadComments, pageId]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!initialQuote?.trim()) return;
    const frame = window.requestAnimationFrame(() => draftRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pageId, blockId, initialQuote]);

  useEffect(() => {
    if (!activeCommentId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        listRef.current?.querySelectorAll<HTMLElement>("[data-comment-id]") ?? []
      ).find((el) => el.dataset.commentId === activeCommentId);
      if (!target) return;
      target.scrollIntoView({ block: "nearest" });
      target.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeCommentId, commentView, comments.length]);

  const topLevel = comments.filter((comment) => !comment.parentId);
  const repliesByParent = new Map<string, Comment[]>();
  for (const comment of comments) {
    if (!comment.parentId) continue;
    repliesByParent.set(comment.parentId, [...(repliesByParent.get(comment.parentId) ?? []), comment]);
  }
  const ordered = blockId
    ? [
        ...topLevel.filter((comment) => comment.blockId === blockId),
        ...topLevel.filter((comment) => comment.blockId !== blockId),
      ]
    : topLevel;
  const open = ordered.filter((comment) => !comment.resolved);
  const resolved = ordered.filter((comment) => comment.resolved);
  const visibleThreads = commentView === "open" ? open : resolved;
  const openCount = topLevel.filter((comment) => !comment.resolved).length;
  const resolvedCount = topLevel.filter((comment) => comment.resolved).length;
  const targetPreview = targetBlock
    ? spansToPlainTextSafe(targetBlock.content?.rich) || targetBlock.plainText || targetBlock.type
    : "";
  const draftMentionQuery = draftMentionRange?.query.trim().toLowerCase() ?? "";
  const replyMentionQuery = replyMentionRange?.query.trim().toLowerCase() ?? "";

  const localMentionPeople = useMemo(() => {
    const people = new Map<string, OrganizationProfile>();
    addMentionProfile(
      people,
      commentMentionProfile({
        userId,
        displayName: currentMember?.displayName ?? currentOrganizationMember?.displayName ?? null,
        email: currentMember?.email ?? currentOrganizationMember?.email ?? null,
        role: currentOrganizationMember?.role ?? currentMember?.role ?? null,
        status: currentOrganizationMember?.status ?? "active",
      })
    );
    for (const member of workspaceMembers) {
      addMentionProfile(
        people,
        commentMentionProfile({
          userId: member.userId,
          displayName: member.displayName,
          email: member.email,
          role: member.role,
          status: "active",
        })
      );
    }
    for (const profile of organizationProfiles) addMentionProfile(people, profile);
    return Array.from(people.values());
  }, [currentMember, currentOrganizationMember, organizationProfiles, userId, workspaceMembers]);

  useEffect(() => {
    const organizationId = organization?.id;
    if (!organizationId || !draftMentionRange || !draftMentionQuery) {
      setSearchedPeople({ key: "", people: [] });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchOrganizationPeopleRemote({
        organizationId,
        query: draftMentionQuery,
        limit: 8,
      })
        .then((result) => {
          if (!cancelled) setSearchedPeople({ key: draftMentionQuery, people: result.people ?? [] });
        })
        .catch(() => {
          if (!cancelled) setSearchedPeople({ key: draftMentionQuery, people: [] });
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [draftMentionQuery, draftMentionRange, organization?.id]);

  const draftMentionPeople = useMemo(() => {
    if (!draftMentionRange) return [];
    const people = new Map<string, OrganizationProfile>();
    const searched = searchedPeople.key === draftMentionQuery ? searchedPeople.people : [];
    for (const profile of [...searched, ...localMentionPeople]) {
      const profileUserId = profile.userId?.trim();
      if (!profileUserId || people.has(profileUserId)) continue;
      if (!commentMentionMatches(profile, draftMentionRange.query)) continue;
      people.set(profileUserId, profile);
    }
    return Array.from(people.values()).slice(0, 8);
  }, [draftMentionQuery, draftMentionRange, localMentionPeople, searchedPeople]);

  useEffect(() => {
    const organizationId = organization?.id;
    if (!organizationId || !replyingId || !replyMentionRange || !replyMentionQuery) {
      setReplySearchedPeople({ key: "", people: [] });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchOrganizationPeopleRemote({
        organizationId,
        query: replyMentionQuery,
        limit: 8,
      })
        .then((result) => {
          if (!cancelled) setReplySearchedPeople({ key: replyMentionQuery, people: result.people ?? [] });
        })
        .catch(() => {
          if (!cancelled) setReplySearchedPeople({ key: replyMentionQuery, people: [] });
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [organization?.id, replyingId, replyMentionQuery, replyMentionRange]);

  const replyMentionPeople = useMemo(() => {
    if (!replyMentionRange) return [];
    const people = new Map<string, OrganizationProfile>();
    const searched = replySearchedPeople.key === replyMentionQuery ? replySearchedPeople.people : [];
    for (const profile of [...searched, ...localMentionPeople]) {
      const profileUserId = profile.userId?.trim();
      if (!profileUserId || people.has(profileUserId)) continue;
      if (!commentMentionMatches(profile, replyMentionRange.query)) continue;
      people.set(profileUserId, profile);
    }
    return Array.from(people.values()).slice(0, 8);
  }, [localMentionPeople, replyMentionQuery, replyMentionRange, replySearchedPeople]);

  useEffect(() => {
    if (!activeCommentId) return;
    const target = comments.find((comment) => comment.id === activeCommentId);
    if (!target) return;
    const thread = target.parentId
      ? comments.find((comment) => comment.id === target.parentId) ?? target
      : target;
    const nextView = thread.resolved ? "resolved" : "open";
    const frame = window.requestAnimationFrame(() => {
      setCommentView((current) => (current === nextView ? current : nextView));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeCommentId, comments]);

  function updateDraftMention(value = draft, cursor = draftRef.current?.selectionStart ?? value.length) {
    const trigger = commentMentionTrigger(value, cursor);
    setDraftMentionRange(trigger);
    setDraftMentionActive(0);
  }

  function updateDraft(value: string, cursor?: number) {
    setDraft(value);
    updateDraftMention(value, cursor ?? value.length);
  }

  function pickDraftMention(profile: OrganizationProfile) {
    if (!draftMentionRange || !profile.userId) return;
    const label = commentMentionLabel(profile);
    const next = commentMentionReplacement(draft, draftMentionRange, label);
    setDraft(next.value);
    setDraftMentions((current) => [
      ...current.filter((mention) => mention.userId !== profile.userId || mention.label !== label),
      { label, userId: profile.userId ?? "" },
    ]);
    setDraftMentionRange(null);
    setDraftMentionActive(0);
    window.requestAnimationFrame(() => {
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function openDraftMentionPicker() {
    const textarea = draftRef.current;
    const start = textarea?.selectionStart ?? draft.length;
    const end = textarea?.selectionEnd ?? start;
    const next = mentionCueInsertion(draft, start, end);
    updateDraft(next.value, next.cursor);
    window.requestAnimationFrame(() => {
      draftRef.current?.focus();
      draftRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function updateReplyMention(value = replyDraft, cursor = value.length) {
    const trigger = commentMentionTrigger(value, cursor);
    setReplyMentionRange(trigger);
    setReplyMentionActive(0);
  }

  function updateReplyDraft(value: string, cursor?: number) {
    setReplyDraft(value);
    updateReplyMention(value, cursor ?? value.length);
  }

  function pickReplyMention(profile: OrganizationProfile) {
    if (!replyMentionRange || !profile.userId) return;
    const label = commentMentionLabel(profile);
    const next = commentMentionReplacement(replyDraft, replyMentionRange, label);
    setReplyDraft(next.value);
    setReplyMentions((current) => [
      ...current.filter((mention) => mention.userId !== profile.userId || mention.label !== label),
      { label, userId: profile.userId ?? "" },
    ]);
    setReplyMentionRange(null);
    setReplyMentionActive(0);
    window.requestAnimationFrame(() => {
      const replyTextarea = panelRef.current?.querySelector<HTMLTextAreaElement>("textarea[data-comment-reply-input]");
      replyTextarea?.focus();
      replyTextarea?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  function openReplyMentionPicker() {
    const replyTextarea = panelRef.current?.querySelector<HTMLTextAreaElement>("textarea[data-comment-reply-input]");
    const start = replyTextarea?.selectionStart ?? replyDraft.length;
    const end = replyTextarea?.selectionEnd ?? start;
    const next = mentionCueInsertion(replyDraft, start, end);
    updateReplyDraft(next.value, next.cursor);
    window.requestAnimationFrame(() => {
      replyTextarea?.focus();
      replyTextarea?.setSelectionRange(next.cursor, next.cursor);
    });
  }

  async function submit() {
    const text = draft.trim();
    if (!text || submitting) return;
    const rich = commentRichWithMentions(text, draftMentions);
    setSubmitting(true);
    setDraft("");
    setDraftMentions([]);
    setDraftMentionRange(null);
    const quote = pendingQuote || undefined;
    setPendingQuote("");
    await addComment(pageId, text, blockId, null, {
      quote,
      quoteStart: initialQuoteStart,
      quoteEnd: initialQuoteEnd,
      rich,
    }).then((comment) => {
      if (!quote || !blockId || !targetBlock) return;
      const rich = targetBlock.content?.rich ?? [];
      const nextRich = addCommentAnchor(rich, initialQuoteStart, initialQuoteEnd, comment.id);
      if (nextRich === rich) return;
      updateBlock(
        targetBlock.id,
        {
          content: { ...targetBlock.content, rich: nextRich },
          plainText: spansToPlainTextSafe(nextRich),
        },
        { history: false }
      );
    }).catch(() => {
      // Terminal rejection: the store rolled the optimistic comment back and
      // already toasted; swallowing here avoids an unhandled rejection.
    }).finally(() => {
      setSubmitting(false);
      window.requestAnimationFrame(() => draftRef.current?.focus());
    });
  }

  function syncCommentAnchor(comment: Comment, resolved: boolean) {
    if (!comment.blockId) return;
    const block = blocks.find((item) => item.id === comment.blockId);
    if (!block) return;
    const rich = block.content?.rich ?? [];
    const range = quoteRange(comment.body);
    const nextRich = resolved
      ? removeCommentAnchor(rich, comment.id)
      : addCommentAnchor(rich, range?.start, range?.end, comment.id);
    if (nextRich === rich) return;
    updateBlock(
      block.id,
      {
        content: { ...block.content, rich: nextRich },
        plainText: spansToPlainTextSafe(nextRich),
      },
      { history: false }
    );
  }

  function toggleResolved(comment: Comment) {
    const resolved = !comment.resolved;
    updateComment(comment.id, { resolved });
    syncCommentAnchor(comment, resolved);
  }

  function saveCommentEdit(comment: Comment, text: string) {
    updateComment(comment.id, {
      body: editedCommentBody(comment, text),
      // Body-only edit marker: resolve/move bump updatedAt too, so the
      // "(edited)" hint keys off this instead.
      editedAt: new Date().toISOString(),
    });
  }

  function removeComment(comment: Comment) {
    // Thread roots take their inline anchor with them; deleteComment removes
    // the replies (store cascades) so only the anchor cleanup lives here.
    if (!comment.parentId) syncCommentAnchor(comment, true);
    deleteComment(comment.id);
  }

  function focusCommentTab(nextView: "open" | "resolved") {
    window.requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLButtonElement>(`[data-comment-tab="${nextView}"]`)
        ?.focus();
    });
  }

  function setCommentViewAndFocus(nextView: "open" | "resolved") {
    setCommentView(nextView);
    focusCommentTab(nextView);
  }

  function onTabKeyDown(e: React.KeyboardEvent<HTMLButtonElement>, currentView: "open" | "resolved") {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const tabs: ("open" | "resolved")[] = ["open", "resolved"];
    const currentIndex = tabs.indexOf(currentView);
    let nextIndex = currentIndex;
    if (e.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === "ArrowLeft") nextIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = tabs.length - 1;
    setCommentViewAndFocus(tabs[nextIndex]);
  }

  function panelFocusables() {
    return Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), textarea:not([disabled]), input:not([type="hidden"]):not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((item) => item.offsetParent !== null && item.tabIndex >= 0);
  }

  function onPanelKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.defaultPrevented) return;
    if (isComposingKeyEvent(e)) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = panelFocusables();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function submitReply(parent: Comment) {
    const text = replyDraft.trim();
    if (!text || submittingReply) return;
    const rich = commentRichWithMentions(text, replyMentions);
    setSubmittingReply(true);
    setReplyDraft("");
    setReplyingId(null);
    setReplyMentionRange(null);
    setReplyMentions([]);
    await addComment(pageId, text, parent.blockId ?? null, parent.id, { rich })
      .catch(() => {
        // Store rolled back + toasted on terminal rejection (see submit()).
      })
      .finally(() => {
        setSubmittingReply(false);
        window.requestAnimationFrame(() => draftRef.current?.focus());
      });
  }

  function flashTarget(el: HTMLElement) {
    el.dataset.commentFlash = "true";
    window.setTimeout(() => {
      delete el.dataset.commentFlash;
    }, 1400);
  }

  function revealCommentInPage(comment: Comment) {
    if (comment.blockId) {
      const url = new URL(window.location.href);
      url.hash = `comment-${encodeURIComponent(comment.id)}`;
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }

    const inlineAnchor = document.querySelector<HTMLElement>(
      `[data-rt-editable] [data-comment-id="${comment.id}"]`
    );
    const blockAnchor = comment.blockId
      ? document.getElementById(`block-${comment.blockId}`)
      : null;
    const target = inlineAnchor ?? blockAnchor;
    if (!target) return;

    target.scrollIntoView({
      behavior: motionSafeScrollBehavior(),
      block: "center",
      inline: "nearest",
    });
    flashTarget(target);

    const editable =
      inlineAnchor?.closest<HTMLElement>("[data-rt-editable]") ??
      blockAnchor?.querySelector<HTMLElement>("[data-rt-editable]");
    window.requestAnimationFrame(() => editable?.focus({ preventScroll: true }));
  }

  return (
    <>
      <button
        type="button"
        className={styles.backdrop}
        onClick={close}
        tabIndex={-1}
        aria-label={LABELS.closeComments}
      />
      <aside
        ref={panelRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onPanelKeyDown}
        data-comments-panel
      >
        <div className={styles.header}>
          <div>
            <div id={titleId} className={styles.title}>
              {LABELS.comments}
            </div>
            <div className={styles.subtitle}>
              {blockId ? LABELS.blockDiscussion : LABELS.pageDiscussion}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={close} aria-label={LABELS.closeComments}>
            <X size={15} />
          </button>
        </div>

        <div className={styles.tabs} role="tablist" aria-label={LABELS.commentStatus}>
          <button
            type="button"
            role="tab"
            aria-selected={commentView === "open"}
            aria-controls={listId}
            tabIndex={commentView === "open" ? 0 : -1}
            data-comment-tab="open"
            className={styles.tab}
            onClick={() => setCommentView("open")}
            onKeyDown={(e) => onTabKeyDown(e, "open")}
          >
            <span>{LABELS.open}</span>
            <span>{openCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={commentView === "resolved"}
            aria-controls={listId}
            tabIndex={commentView === "resolved" ? 0 : -1}
            data-comment-tab="resolved"
            className={styles.tab}
            onClick={() => setCommentView("resolved")}
            onKeyDown={(e) => onTabKeyDown(e, "resolved")}
          >
            <span>{LABELS.resolved}</span>
            <span>{resolvedCount}</span>
          </button>
        </div>

        {blockId && (
          <div className={styles.anchorPreview}>
            <span>{pendingQuote ? LABELS.commentingOnSelectedText : LABELS.commentingOn}</span>
            <strong>{pendingQuote || targetPreview || LABELS.selectedBlock}</strong>
          </div>
        )}

        {canComment && (
        <div className={styles.composer} data-comments-composer>
          <div className={styles.composerBox}>
            <textarea
              ref={draftRef}
              value={draft}
              aria-label={blockId ? LABELS.addBlockComment : LABELS.addPageComment}
              onChange={(e) => updateDraft(e.target.value, e.currentTarget.selectionStart)}
              onClick={(e) => updateDraftMention(draft, e.currentTarget.selectionStart)}
              onKeyUp={(e) => updateDraftMention(draft, e.currentTarget.selectionStart)}
              placeholder={blockId ? LABELS.blockCommentPlaceholder : LABELS.pageCommentPlaceholder}
              rows={3}
              onKeyDown={(e) => {
                if (isComposingKeyEvent(e)) return;
                if (draftMentionRange && draftMentionPeople.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setDraftMentionActive((current) => (current + 1) % draftMentionPeople.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setDraftMentionActive((current) =>
                      current <= 0 ? draftMentionPeople.length - 1 : current - 1
                    );
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    pickDraftMention(draftMentionPeople[draftMentionActive] ?? draftMentionPeople[0]);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setDraftMentionRange(null);
                    return;
                  }
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  void submit();
                }
              }}
            />
            {draftMentionRange && (
              <div className={styles.mentionMenu} role="listbox" aria-label={LABELS.commentMentionPeople}>
                {draftMentionPeople.length > 0 ? draftMentionPeople.map((profile, index) => {
                  const label = commentMentionLabel(profile);
                  return (
                    <button
                      key={profile.userId ?? label}
                      type="button"
                      role="option"
                      aria-selected={index === draftMentionActive}
                      data-active={index === draftMentionActive ? "true" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => pickDraftMention(profile)}
                    >
                      <span className={styles.mentionAvatar}>{label.slice(0, 1).toUpperCase()}</span>
                      <span className={styles.mentionText}>
                        <span>{label}</span>
                        <span>{commentMentionDescription(profile)}</span>
                      </span>
                    </button>
                  );
                }) : (
                  <div className={styles.mentionEmpty}>{LABELS.noMatchingPeople}</div>
                )}
              </div>
            )}
            <div className={styles.composerFoot}>
              <span>{blockId ? LABELS.blockDiscussion : LABELS.pageDiscussion}</span>
              <div className={styles.composerActions}>
                <button
                  type="button"
                  className={styles.mentionTrigger}
                  aria-label={LABELS.mentionPeople}
                  title={LABELS.mentionPeople}
                  onClick={openDraftMentionPicker}
                >
                  @
                </button>
                <button
                  type="button"
                  className={styles.submitButton}
                  disabled={!draft.trim() || submitting}
                  onClick={() => void submit()}
                >
                  {LABELS.comment}
                </button>
              </div>
            </div>
          </div>
        </div>
        )}

        <div
          id={listId}
          className={styles.list}
          ref={listRef}
          role="list"
          aria-label={LABELS.commentThreads}
        >
          {topLevel.length === 0 && (
            <div className={styles.empty} role="status">{LABELS.noCommentsYet}</div>
          )}
          {topLevel.length > 0 && visibleThreads.length === 0 && (
            <div className={styles.empty} role="status">
              {commentView === "open" ? LABELS.noOpenComments : LABELS.noResolvedComments}
            </div>
          )}
          {visibleThreads.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              activeBlockId={blockId}
              userId={userId}
              canComment={canComment}
              canEditPage={canEditThisPage}
              replies={repliesByParent.get(comment.id) ?? []}
              replying={replyingId === comment.id}
              replyDraft={replyDraft}
              replyMentionRange={replyMentionRange}
              replyMentionActive={replyMentionActive}
              replyMentionPeople={replyMentionPeople}
              submittingReply={submittingReply}
              active={comment.id === activeCommentId}
              onRevealAnchor={() => revealCommentInPage(comment)}
              onStartReply={() => {
                setReplyingId(comment.id);
                setReplyDraft("");
                setReplyMentionRange(null);
                setReplyMentionActive(0);
                setReplyMentions([]);
              }}
              onCancelReply={() => {
                setReplyingId(null);
                setReplyDraft("");
                setReplyMentionRange(null);
                setReplyMentionActive(0);
                setReplyMentions([]);
              }}
              onReplyDraft={updateReplyDraft}
              onReplyMention={updateReplyMention}
              onReplyMentionActive={setReplyMentionActive}
              onPickReplyMention={pickReplyMention}
              onOpenReplyMentionPicker={openReplyMentionPicker}
              onSubmitReply={() => void submitReply(comment)}
              onToggleResolved={() => toggleResolved(comment)}
              onEditComment={saveCommentEdit}
              onDeleteComment={removeComment}
            />
          ))}
        </div>
      </aside>
    </>
  );
}

function CommentCard({
  comment,
  activeBlockId,
  userId,
  canComment,
  canEditPage: canEditThisPage,
  replies,
  replying,
  replyDraft,
  replyMentionRange,
  replyMentionActive,
  replyMentionPeople,
  submittingReply,
  active,
  onRevealAnchor,
  onStartReply,
  onCancelReply,
  onReplyDraft,
  onReplyMention,
  onReplyMentionActive,
  onPickReplyMention,
  onOpenReplyMentionPicker,
  onSubmitReply,
  onToggleResolved,
  onEditComment,
  onDeleteComment,
}: {
  comment: Comment;
  activeBlockId?: string | null;
  userId?: string;
  canComment: boolean;
  canEditPage: boolean;
  replies: Comment[];
  replying: boolean;
  replyDraft: string;
  replyMentionRange: CommentMentionRange | null;
  replyMentionActive: number;
  replyMentionPeople: OrganizationProfile[];
  submittingReply: boolean;
  active?: boolean;
  onRevealAnchor: () => void;
  onStartReply: () => void;
  onCancelReply: () => void;
  onReplyDraft: (value: string, cursor?: number) => void;
  onReplyMention: (value?: string, cursor?: number) => void;
  onReplyMentionActive: (value: number | ((current: number) => number)) => void;
  onPickReplyMention: (profile: OrganizationProfile) => void;
  onOpenReplyMentionPicker: () => void;
  onSubmitReply: () => void;
  onToggleResolved: () => void;
  onEditComment: (comment: Comment, text: string) => void;
  onDeleteComment: (comment: Comment) => void;
}) {
  const spans = richTextSpans(comment.body);
  const text = spansToPlainTextSafe(spans);
  const quote = quoteText(comment.body);
  const isTarget = !!activeBlockId && comment.blockId === activeBlockId;
  const author = authorLabel(comment, userId);
  const time = timeLabel(comment.createdAt);
  const isOwn = !!userId && comment.authorId === userId;
  // Backend rule (assertCanChangeComment): edit access OR authorship.
  const canResolve = canComment && (canEditThisPage || isOwn);
  const canManageOwn = canComment && isOwn;
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function startEdit() {
    setConfirmingDelete(false);
    setEditDraft(text);
    setEditing(true);
  }

  function saveEdit() {
    const next = editDraft.trim();
    if (!next) return;
    if (next !== text) onEditComment(comment, next);
    setEditing(false);
  }

  return (
    <article
      className={styles.comment}
      role="listitem"
      aria-label={LABELS.commentAria(author, time, !!comment.resolved)}
      tabIndex={active ? -1 : undefined}
      data-comment-id={comment.id}
      data-active={active ? "true" : undefined}
      data-resolved={comment.resolved ? "true" : undefined}
      data-target={isTarget ? "true" : undefined}
    >
      <div className={styles.avatar} aria-hidden="true">{author.slice(0, 1)}</div>
      <div className={styles.commentBody}>
        <div className={styles.commentMeta}>
          <span>{author}</span>
          <span>{time}</span>
          {comment.editedAt ? <span>{LABELS.edited}</span> : null}
        </div>
        {comment.blockId && (
          <div className={styles.anchorLabel}>
            {quote ? LABELS.onSelectedText : isTarget ? LABELS.onSelectedBlock : LABELS.onABlock}
          </div>
        )}
        {quote && <div className={styles.commentQuote}>{quote}</div>}
        {editing ? (
          <CommentEditComposer
            draft={editDraft}
            onDraft={setEditDraft}
            onCancel={() => setEditing(false)}
            onSave={saveEdit}
          />
        ) : (
          <div className={styles.commentText}>{text ? renderCommentRichText(spans) : LABELS.emptyComment}</div>
        )}
        <div className={styles.commentActions}>
          {canComment && <button type="button" onClick={onStartReply}>{LABELS.reply}</button>}
          {comment.blockId && (
            <button type="button" onClick={onRevealAnchor}>
              {LABELS.showInPage}
            </button>
          )}
          {canResolve && (
            <button
              type="button"
              aria-pressed={!!comment.resolved}
              onClick={onToggleResolved}
            >
              {comment.resolved ? LABELS.reopen : LABELS.resolve}
            </button>
          )}
          {canManageOwn && !editing && (
            <button type="button" onClick={startEdit} data-comment-action="edit">
              {LABELS.edit}
            </button>
          )}
          {canManageOwn && (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              data-comment-action="delete"
            >
              {LABELS.delete}
            </button>
          )}
        </div>
        {confirmingDelete && (
          <div className={styles.deleteConfirm} data-testid="comment-delete-confirm">
            <span>
              {replies.length > 0
                ? LABELS.deleteThreadConfirm(replies.length)
                : LABELS.deleteCommentConfirm}
            </span>
            <div className={styles.deleteConfirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setConfirmingDelete(false)}
              >
                {LABELS.cancel}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => onDeleteComment(comment)}
              >
                {LABELS.delete}
              </button>
            </div>
          </div>
        )}
        {(replies.length > 0 || replying) && (
          <div className={styles.replies} role="list" aria-label={LABELS.repliesAria(replies.length)}>
            {replies.map((reply) => (
              <ReplyCard
                key={reply.id}
                comment={reply}
                userId={userId}
                canComment={canComment}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
              />
            ))}
            {replying && (
              <div className={styles.replyComposer} role="listitem">
                <div className={styles.replyComposerBox}>
                  <textarea
                    value={replyDraft}
                    rows={2}
                    aria-label={LABELS.reply}
                    data-comment-reply-input="true"
                    placeholder={LABELS.replyPlaceholder}
                    onChange={(e) => onReplyDraft(e.target.value, e.currentTarget.selectionStart)}
                    onClick={(e) => onReplyMention(replyDraft, e.currentTarget.selectionStart)}
                    onKeyUp={(e) => onReplyMention(replyDraft, e.currentTarget.selectionStart)}
                    onKeyDown={(e) => {
                      if (isComposingKeyEvent(e)) return;
                      if (replyMentionRange && replyMentionPeople.length > 0) {
                        if (e.key === "ArrowDown") {
                          e.preventDefault();
                          onReplyMentionActive((current) => (current + 1) % replyMentionPeople.length);
                          return;
                        }
                        if (e.key === "ArrowUp") {
                          e.preventDefault();
                          onReplyMentionActive((current) =>
                            current <= 0 ? replyMentionPeople.length - 1 : current - 1
                          );
                          return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                          e.preventDefault();
                          onPickReplyMention(replyMentionPeople[replyMentionActive] ?? replyMentionPeople[0]);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          onReplyMention("", 0);
                          return;
                        }
                      }
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        onSubmitReply();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        onCancelReply();
                      }
                    }}
                    autoFocus
                  />
                  {replyMentionRange && (
                    <div className={styles.mentionMenu} role="listbox" aria-label={LABELS.replyMentionPeople}>
                      {replyMentionPeople.length > 0 ? replyMentionPeople.map((profile, index) => {
                        const label = commentMentionLabel(profile);
                        return (
                          <button
                            key={profile.userId ?? label}
                            type="button"
                            role="option"
                            aria-selected={index === replyMentionActive}
                            data-active={index === replyMentionActive ? "true" : undefined}
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onPickReplyMention(profile)}
                          >
                            <span className={styles.mentionAvatar}>{label.slice(0, 1).toUpperCase()}</span>
                            <span className={styles.mentionText}>
                              <span>{label}</span>
                              <span>{commentMentionDescription(profile)}</span>
                            </span>
                          </button>
                        );
                      }) : (
                        <div className={styles.mentionEmpty}>{LABELS.noMatchingPeople}</div>
                      )}
                    </div>
                  )}
                  <div className={styles.replyComposerFoot}>
                    <button
                      type="button"
                      className={styles.mentionTrigger}
                      aria-label={LABELS.mentionPeople}
                      title={LABELS.mentionPeople}
                      onClick={onOpenReplyMentionPicker}
                    >
                      @
                    </button>
                    <div className={styles.replyComposerActions}>
                      <button type="button" className={styles.secondaryButton} onClick={onCancelReply}>
                        {LABELS.cancel}
                      </button>
                      <button
                        type="button"
                        className={styles.replySubmitButton}
                        disabled={!replyDraft.trim() || submittingReply}
                        onClick={onSubmitReply}
                      >
                        {LABELS.reply}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

// Inline body editor shared by comment and reply cards. Prefills with the
// comment's plain text; Escape cancels, Cmd/Ctrl+Enter saves.
function CommentEditComposer({
  draft,
  onDraft,
  onCancel,
  onSave,
}: {
  draft: string;
  onDraft: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className={styles.replyComposer} data-comment-edit-composer>
      <div className={styles.replyComposerBox}>
        <textarea
          value={draft}
          rows={3}
          aria-label={LABELS.editComment}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isComposingKeyEvent(e)) return;
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              onSave();
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              onCancel();
            }
          }}
          autoFocus
        />
        <div className={styles.replyComposerFoot}>
          <span />
          <div className={styles.replyComposerActions}>
            <button type="button" className={styles.secondaryButton} onClick={onCancel}>
              {LABELS.cancel}
            </button>
            <button
              type="button"
              className={styles.replySubmitButton}
              disabled={!draft.trim()}
              onClick={onSave}
            >
              {LABELS.save}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReplyCard({
  comment,
  userId,
  canComment,
  onEditComment,
  onDeleteComment,
}: {
  comment: Comment;
  userId?: string;
  canComment: boolean;
  onEditComment: (comment: Comment, text: string) => void;
  onDeleteComment: (comment: Comment) => void;
}) {
  const spans = richTextSpans(comment.body);
  const text = spansToPlainTextSafe(spans);
  const author = authorLabel(comment, userId);
  const time = timeLabel(comment.createdAt);
  const canManageOwn = canComment && !!userId && comment.authorId === userId;
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  function saveEdit() {
    const next = editDraft.trim();
    if (!next) return;
    if (next !== text) onEditComment(comment, next);
    setEditing(false);
  }

  return (
    <article className={styles.reply} role="listitem" aria-label={LABELS.replyAria(author, time)}>
      <div className={styles.replyAvatar} aria-hidden="true">{author.slice(0, 1)}</div>
      <div className={styles.replyBody}>
        <div className={styles.commentMeta}>
          <span>{author}</span>
          <span>{time}</span>
          {comment.editedAt ? <span>{LABELS.edited}</span> : null}
        </div>
        {editing ? (
          <CommentEditComposer
            draft={editDraft}
            onDraft={setEditDraft}
            onCancel={() => setEditing(false)}
            onSave={saveEdit}
          />
        ) : (
          <div className={styles.commentText}>{text ? renderCommentRichText(spans) : LABELS.emptyReply}</div>
        )}
        {canManageOwn && !editing && (
          <div className={styles.commentActions}>
            <button
              type="button"
              onClick={() => {
                setConfirmingDelete(false);
                setEditDraft(text);
                setEditing(true);
              }}
              data-comment-action="edit"
            >
              {LABELS.edit}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              data-comment-action="delete"
            >
              {LABELS.delete}
            </button>
          </div>
        )}
        {confirmingDelete && (
          <div className={styles.deleteConfirm} data-testid="comment-delete-confirm">
            <span>{LABELS.deleteCommentConfirm}</span>
            <div className={styles.deleteConfirmActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setConfirmingDelete(false)}
              >
                {LABELS.cancel}
              </button>
              <button
                type="button"
                className={styles.dangerButton}
                onClick={() => onDeleteComment(comment)}
              >
                {LABELS.delete}
              </button>
            </div>
          </div>
        )}
      </div>
    </article>
  );
}

function spansToPlainTextSafe(spans?: TextSpan[]): string {
  return (spans ?? []).map((span) => span.text).join("");
}
