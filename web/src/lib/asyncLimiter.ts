type AsyncLimiterOptions = {
  signal?: AbortSignal;
};

type AsyncLimiterWaiter = {
  reject: (error: unknown) => void;
  resolve: () => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

function limiterAbortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function throwIfLimiterAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw limiterAbortReason(signal);
}

export function createAsyncLimiter(maxConcurrent: number) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error("maxConcurrent must be a positive integer");
  }

  let active = 0;
  const waiting: AsyncLimiterWaiter[] = [];

  const release = () => {
    let next = waiting.shift();
    while (next?.signal?.aborted) {
      if (next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      next.reject(limiterAbortReason(next.signal));
      next = waiting.shift();
    }
    if (next) {
      // Transfer the occupied slot directly. Decrementing first would let a
      // newcomer enter before the awakened waiter resumes in its microtask.
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve();
      return;
    }
    active -= 1;
  };

  return async function limit<T>(
    operation: () => Promise<T>,
    options: AsyncLimiterOptions = {}
  ): Promise<T> {
    const signal = options.signal;
    throwIfLimiterAborted(signal);
    if (active >= maxConcurrent) {
      await new Promise<void>((resolve, reject) => {
        const waiter: AsyncLimiterWaiter = { reject, resolve, signal };
        if (signal) {
          waiter.onAbort = () => {
            const index = waiting.indexOf(waiter);
            if (index < 0) return;
            waiting.splice(index, 1);
            reject(limiterAbortReason(signal));
          };
          signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        waiting.push(waiter);
      });
    } else {
      active += 1;
    }
    try {
      throwIfLimiterAborted(signal);
      return await operation();
    } finally {
      release();
    }
  };
}
