/**
 * The authoritative half of Hanji's durable mutation lifecycle.
 *
 * Optimistic projection and durable enqueue happen before this runner. Once a
 * lane starts sending, completion must stay in this exact order:
 *
 * remote accepted -> authoritative local/cache commit -> outbox acknowledge.
 *
 * A caller may retry a failed send or local commit, but it must never remove
 * the outbox entry before the local cache can reproduce the accepted result.
 */

export type AcknowledgedMutationPhase =
  | "remote_sending"
  | "remote_accepted"
  | "local_committing"
  | "local_committed"
  | "outbox_acknowledging"
  | "completed";

export interface AcknowledgedMutationOptions<Result> {
  acknowledge: () => Promise<void> | void;
  commit: (result: Result) => Promise<void> | void;
  onPhase?: (phase: AcknowledgedMutationPhase) => void;
  send: () => Promise<Result>;
}

export async function runAcknowledgedMutation<Result>(
  options: AcknowledgedMutationOptions<Result>
): Promise<Result> {
  const phase = (next: AcknowledgedMutationPhase) => options.onPhase?.(next);

  phase("remote_sending");
  const result = await options.send();
  phase("remote_accepted");

  phase("local_committing");
  await options.commit(result);
  phase("local_committed");

  phase("outbox_acknowledging");
  const acknowledgment = options.acknowledge();
  // Most outbox acknowledgements synchronously enqueue work onto their own
  // durable FIFO and return void. Do not add a needless microtask in that
  // common path: serialized mutation lanes can immediately observe and flush
  // a newer generation. Truly asynchronous acknowledgements are still fully
  // awaited before completion.
  if (acknowledgment && typeof acknowledgment.then === "function") {
    await acknowledgment;
  }
  phase("completed");
  return result;
}
