export const PAGE_ROOM_SHARED_SIGNAL_LIMIT = 20;
export const PAGE_ROOM_SIGNAL_WINDOW_MS = 1_000;
export const PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS = 55;
export const PAGE_ROOM_SIGNAL_ACTIVE_SEND_TIMEOUT_MS = 10_000;
export const PAGE_ROOM_SIGNAL_WINDOW_BOUND = Math.ceil(
  PAGE_ROOM_SIGNAL_WINDOW_MS / PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS,
);
export const PAGE_ROOM_SIGNAL_MAX_PENDING = 200;
export const PAGE_ROOM_SIGNAL_MAX_PACED_QUEUE_WAIT_MS =
  (PAGE_ROOM_SIGNAL_MAX_PENDING + 1) * PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS;
export const PAGE_ROOM_SIGNAL_MAX_STRUCTURE_START_WAIT_MS =
  PAGE_ROOM_SIGNAL_ACTIVE_SEND_TIMEOUT_MS + PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS;
export const PAGE_ROOM_SIGNAL_MAX_ACCEPTED_SETTLEMENT_WAIT_MS =
  (PAGE_ROOM_SIGNAL_MAX_PENDING + 1) *
  (PAGE_ROOM_SIGNAL_ACTIVE_SEND_TIMEOUT_MS + PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS);
export type PageRoomOutboundLane =
  | "awareness"
  | "crdt"
  | "mutation"
  | "structure"
  | "text";

type PageRoomOutboundTask = {
  lane: PageRoomOutboundLane;
  reject: (error: Error) => void;
  resolve: () => void;
  run: () => Promise<void>;
};

type PageRoomOutboundSchedulerOptions = {
  isConnected: () => boolean;
};

const LOW_LANES: PageRoomOutboundLane[] = ["mutation", "crdt", "text", "awareness"];
const QUEUE_FULL_ERROR = "Page room outbound queue full";
const QUEUE_CANCELLED_ERROR = "Page room outbound queue cancelled";

/**
 * One bounded wire authority for every signal on a mounted page connection.
 *
 * Starts are peak-one and at least 55ms apart, which caps every rolling
 * one-second attempt window at 19 against EdgeBase's 20/s connection bucket.
 * Structure always owns the next available start; lower lanes round-robin so
 * one advisory class cannot starve the others. The shared queue is capped at
 * 200 tasks (11.055s paced-queue wait after any active wire attempt settles),
 * and awareness retains only its newest pending state. An active transport
 * promise is bounded by pagePresence's explicit 10s SDK send timeout. Thus a
 * committed structure task starts within one active timeout plus one pace
 * interval, while even a tail low-priority task has a finite shared-cap bound.
 * This layer never retries or classifies a wire error: the owning aggregation
 * lane receives the original rejection.
 */
export function createPageRoomOutboundScheduler({
  isConnected,
}: PageRoomOutboundSchedulerOptions) {
  const queues = new Map<PageRoomOutboundLane, PageRoomOutboundTask[]>([
    ["awareness", []],
    ["crdt", []],
    ["mutation", []],
    ["structure", []],
    ["text", []],
  ]);
  let accepting = true;
  let acceptingLow = true;
  let active = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let lowCursor = 0;
  let paceTimer: number | undefined;
  let paceDueAt: number | undefined;
  let idlePromise: Promise<void> | undefined;
  let resolveIdle: (() => void) | undefined;

  function pendingCount(lane?: PageRoomOutboundLane) {
    if (lane) return queues.get(lane)?.length ?? 0;
    return Array.from(queues.values()).reduce((total, queue) => total + queue.length, 0);
  }

  function clearPaceTimer() {
    if (paceTimer !== undefined) window.clearTimeout(paceTimer);
    paceTimer = undefined;
    paceDueAt = undefined;
  }

  function settleIdleWaiters() {
    if (active || paceTimer !== undefined || pendingCount() > 0) return;
    resolveIdle?.();
    idlePromise = undefined;
    resolveIdle = undefined;
  }

  function waitForIdle() {
    if (!active && paceTimer === undefined && pendingCount() === 0) return Promise.resolve();
    if (!idlePromise) {
      idlePromise = new Promise<void>((resolve) => {
        resolveIdle = resolve;
      });
    }
    return idlePromise;
  }

  function rejectTask(task: PageRoomOutboundTask, message: string) {
    task.reject(new Error(message));
  }

  function makeRoomFor(lane: PageRoomOutboundLane) {
    if (lane === "awareness") {
      const replaced = queues.get("awareness")?.shift();
      if (replaced) rejectTask(replaced, QUEUE_CANCELLED_ERROR);
    }
    // Low lanes stop one slot short so a later committed structure summary is
    // admitted without evicting already-accepted work. Overflow rejects only
    // the new caller; accepted FIFO work always drains.
    const limit =
      lane === "structure"
        ? PAGE_ROOM_SIGNAL_MAX_PENDING
        : PAGE_ROOM_SIGNAL_MAX_PENDING - 1;
    return pendingCount() < limit;
  }

  function nextLane() {
    if ((queues.get("structure")?.length ?? 0) > 0) return "structure" as const;
    for (let offset = 0; offset < LOW_LANES.length; offset += 1) {
      const index = (lowCursor + offset) % LOW_LANES.length;
      const lane = LOW_LANES[index];
      if ((queues.get(lane)?.length ?? 0) === 0) continue;
      lowCursor = (index + 1) % LOW_LANES.length;
      return lane;
    }
    return undefined;
  }

  function schedulePace(dueAt: number) {
    if (paceDueAt !== undefined && paceDueAt <= dueAt) return;
    clearPaceTimer();
    paceDueAt = dueAt;
    paceTimer = window.setTimeout(() => {
      paceTimer = undefined;
      paceDueAt = undefined;
      drain();
    }, Math.max(0, dueAt - Date.now()));
  }

  async function execute(task: PageRoomOutboundTask) {
    let failure: unknown;
    try {
      await task.run();
    } catch (error) {
      failure = error;
    }

    active = false;
    // Select/start the next task before resolving this lower-lane caller, so
    // an already-queued structure send cannot be overtaken by its continuation.
    drain();
    if (failure === undefined) task.resolve();
    else task.reject(failure instanceof Error ? failure : new Error(String(failure)));
    settleIdleWaiters();
  }

  function drain() {
    const connected = isConnected();
    // Once page cleanup has closed every lower lane, a disconnected queued
    // structure task has no remaining wire opportunity. Reject it through the
    // same scheduler promise so the structure batcher can finish disposal;
    // keeping it accepted here would make scheduler disposal unreachable.
    // Connected cleanup still preserves the structure task for its one
    // sequential lifecycle send, and an already-active send remains bounded
    // by the room SDK timeout configured by pagePresence.
    if (!acceptingLow && !connected) {
      for (const task of queues.get("structure")?.splice(0) ?? []) {
        rejectTask(task, QUEUE_CANCELLED_ERROR);
      }
    }
    if (!accepting || active || paceTimer !== undefined || !connected) {
      settleIdleWaiters();
      return;
    }
    if (pendingCount() === 0) {
      settleIdleWaiters();
      return;
    }
    const now = Date.now();
    const nextStartAt = lastStartedAt + PAGE_ROOM_SIGNAL_MIN_INTERVAL_MS;
    if (now < nextStartAt) {
      schedulePace(nextStartAt);
      return;
    }
    const lane = nextLane();
    if (!lane) return;
    const task = queues.get(lane)?.shift();
    if (!task) return;
    lastStartedAt = now;
    active = true;
    void execute(task);
  }

  function schedule(lane: PageRoomOutboundLane, run: () => Promise<void>) {
    if (!accepting || (lane !== "structure" && !acceptingLow)) {
      return Promise.reject(new Error(QUEUE_CANCELLED_ERROR));
    }
    if (!makeRoomFor(lane)) return Promise.reject(new Error(QUEUE_FULL_ERROR));
    const promise = new Promise<void>((resolve, reject) => {
      queues.get(lane)?.push({ lane, reject, resolve, run });
    });
    drain();
    return promise;
  }

  function flush() {
    if (!isConnected()) return Promise.resolve();
    drain();
    return waitForIdle();
  }

  function cancelNonStructure() {
    acceptingLow = false;
    for (const lane of LOW_LANES) {
      for (const task of queues.get(lane)?.splice(0) ?? []) {
        rejectTask(task, QUEUE_CANCELLED_ERROR);
      }
    }
    clearPaceTimer();
    drain();
    settleIdleWaiters();
  }

  function dispose() {
    accepting = false;
    acceptingLow = false;
    clearPaceTimer();
    for (const queue of queues.values()) {
      for (const task of queue.splice(0)) rejectTask(task, QUEUE_CANCELLED_ERROR);
    }
    settleIdleWaiters();
    return waitForIdle();
  }

  return {
    cancelNonStructure,
    dispose,
    flush,
    pendingCount,
    schedule,
  };
}
