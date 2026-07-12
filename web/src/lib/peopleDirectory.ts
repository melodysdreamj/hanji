import type { OrganizationProfile, WorkspaceMember } from "./types";
import { i18next } from "@/i18n";

type PersonDirectoryEntry = {
  userId: string;
  displayName?: string | null;
  email?: string | null;
};

let peopleByUserId = new Map<string, PersonDirectoryEntry>();

function mergePerson(map: Map<string, PersonDirectoryEntry>, person: PersonDirectoryEntry | undefined) {
  if (!person) return;
  const userId = person.userId.trim();
  if (!userId) return;
  const existing = map.get(userId);
  map.set(userId, {
    userId,
    displayName: person.displayName?.trim() || existing?.displayName || null,
    email: person.email?.trim() || existing?.email || null,
  });
}

export function setWorkspacePeople(members: WorkspaceMember[] = [], organizationProfiles: OrganizationProfile[] = []) {
  const next = new Map<string, PersonDirectoryEntry>();
  for (const profile of organizationProfiles) {
    if (!profile.userId) continue;
    mergePerson(next, {
      userId: profile.userId,
      displayName: profile.displayName,
      email: profile.email,
    });
  }
  for (const member of members) {
    mergePerson(next, member);
  }
  peopleByUserId = next;
}

export function normalizePersonIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => normalizePersonIds(item))
      .filter(Boolean);
  }
  if (!value) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.userId;
  if (typeof id !== "string" || !id.trim()) return [];
  const userId = id.trim();
  const notion = typeof record.notion === "object" && record.notion ? record.notion as Record<string, unknown> : undefined;
  const notionPerson =
    typeof notion?.person === "object" && notion.person ? notion.person as Record<string, unknown> : undefined;
  mergePerson(peopleByUserId, {
    userId,
    displayName:
      typeof record.displayName === "string"
        ? record.displayName
        : typeof record.name === "string"
          ? record.name
          : typeof notion?.name === "string"
            ? notion.name
            : null,
    email:
      typeof record.email === "string"
        ? record.email
        : typeof notionPerson?.email === "string"
          ? notionPerson.email
          : null,
  });
  return [userId];
}

function displayName(member: PersonDirectoryEntry | undefined) {
  return member?.displayName?.trim() || member?.email?.trim() || "";
}

export function personLabel(id: string, currentUserId?: string) {
  if (!id) return "";
  const label = displayName(peopleByUserId.get(id));
  if (label)
    return currentUserId && id === currentUserId
      ? `${label} (${i18next.t("peopleDirectory:youSuffix")})`
      : label;
  if (currentUserId && id === currentUserId) return i18next.t("peopleDirectory:you");
  if (id === "local-user") return i18next.t("peopleDirectory:you");
  // A removed guest/former member can leave a stable UUID on old records.
  // Showing fragments such as "User 8f31...b921" leaks implementation detail
  // and looks like a corrupt identity; fail to the localized guest label.
  return i18next.t("peopleDirectory:guest");
}

export function actorLabel(id?: string | null, currentUserId?: string) {
  return id ? personLabel(id, currentUserId) : i18next.t("peopleDirectory:you");
}

export function personInitials(id: string, currentUserId?: string) {
  const label = personLabel(id, currentUserId);
  const words = label
    .replace(/\((?:you|나)\)$/i, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return (words[0] || "U").slice(0, 2).toUpperCase();
}
