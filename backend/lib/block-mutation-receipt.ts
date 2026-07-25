export const SERVER_BLOCK_MUTATION_RECEIPT_PREFIX = 'server:block:';

export function isServerBlockMutationReceipt(value: string) {
  return value.startsWith(SERVER_BLOCK_MUTATION_RECEIPT_PREFIX);
}

export function crdtCheckpointMutationReceipt(operationId: string) {
  return `${SERVER_BLOCK_MUTATION_RECEIPT_PREFIX}crdt:${operationId}`;
}
