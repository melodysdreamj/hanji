export type PageMutationReceiptState = {
  lastEditedBy?: string;
  lastMutationId?: string;
  updatedAt?: string;
};

export function optionalPageMutationUpdatedAt(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('expectedUpdatedAt must be a non-empty string when provided.');
  }
  return value.trim();
}

export function optionalPageMutationId(
  value: unknown,
  field: 'mutationId' | 'expectedMutationId',
) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 160) {
    throw new Error(`${field} must be a non-empty string of at most 160 characters when provided.`);
  }
  return value.trim();
}

export function isExactPageMutationReplay(
  current: PageMutationReceiptState,
  mutationId: string | undefined,
  actorId: string,
) {
  return !!mutationId
    && current.lastMutationId === mutationId
    && current.lastEditedBy === actorId;
}

export function pageMutationBaseMatches(
  current: PageMutationReceiptState,
  expectedUpdatedAt: string | undefined,
  expectedMutationId: string | undefined,
  actorId: string,
) {
  if (!expectedUpdatedAt && !expectedMutationId) return true;
  const timestampMatches = !!expectedUpdatedAt && current.updatedAt === expectedUpdatedAt;
  const predecessorMatches = !!expectedMutationId
    && current.lastMutationId === expectedMutationId
    && current.lastEditedBy === actorId;
  return timestampMatches || predecessorMatches;
}
