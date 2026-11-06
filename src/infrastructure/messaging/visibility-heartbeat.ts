/** Abort transport I/O and bound cleanup even if a broken transport ignores cancellation. */
export async function settleWithin(work: Promise<unknown>, milliseconds: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

export async function changeVisibilityWithin(change: (signal: AbortSignal) => Promise<void>, milliseconds: number): Promise<void> {
  const controller = new AbortController();
  try { await settleWithin(Promise.resolve().then(() => change(controller.signal)), milliseconds); }
  finally { controller.abort(); }
}

export function visibilityHeartbeat(extend: (signal: AbortSignal) => Promise<void>, intervalMs: number,
  cleanupTimeoutMs: number, onError: (error: unknown) => void): () => Promise<void> {
  const controller = new AbortController();
  let stopped = false;
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (stopped || pending) return;
    pending = Promise.resolve().then(() => extend(controller.signal))
      .catch(error => { if (!stopped) onError(error); }).finally(() => { pending = undefined; });
  }, intervalMs);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    controller.abort();
    await settleWithin(pending ?? Promise.resolve(), cleanupTimeoutMs);
  };
}
