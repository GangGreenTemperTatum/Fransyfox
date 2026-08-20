export interface EventBatch<T> {
  events: T[];
  dropped: number;
}

export interface TimedEventBatcher<T> {
  enqueue: (event: T, floodProtectionEnabled?: boolean) => boolean;
  flushAll: () => void;
  discard: () => void;
  pendingCount: () => number;
}

export function createTimedEventBatcher<T>(options: {
  flushIntervalMs: number;
  maxBatchSize: number;
  hardCap: number;
  onBatch: (batch: EventBatch<T>) => void;
}): TimedEventBatcher<T> {
  const flushIntervalMs = Math.max(0, Math.floor(options.flushIntervalMs));
  const maxBatchSize = Math.max(1, Math.floor(options.maxBatchSize));
  const hardCap = Math.max(maxBatchSize, Math.floor(options.hardCap));
  let queue: T[] = [];
  let droppedCount = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function clearScheduledFlush(): void {
    if (flushTimer === null) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushNext();
    }, flushIntervalMs);
  }

  function flushNext(): void {
    clearScheduledFlush();
    if (queue.length === 0 && droppedCount === 0) return;

    const events = queue.splice(0, maxBatchSize);
    const dropped = droppedCount;
    droppedCount = 0;
    options.onBatch({ events, dropped });

    if (queue.length > 0) {
      scheduleFlush();
    }
  }

  function enqueue(event: T, floodProtectionEnabled = true): boolean {
    if (floodProtectionEnabled && queue.length >= hardCap) {
      droppedCount += 1;
      scheduleFlush();
      return false;
    }

    queue.push(event);
    if (!floodProtectionEnabled && queue.length >= maxBatchSize) {
      // Preserve capture-all behavior when protection is explicitly disabled:
      // batch messages, but do not let a rate-limited queue grow without bound.
      flushNext();
    } else {
      scheduleFlush();
    }
    return true;
  }

  function flushAll(): void {
    clearScheduledFlush();
    if (queue.length === 0 && droppedCount === 0) return;

    const events = queue;
    const dropped = droppedCount;
    queue = [];
    droppedCount = 0;
    options.onBatch({ events, dropped });
  }

  function discard(): void {
    clearScheduledFlush();
    queue = [];
    droppedCount = 0;
  }

  return {
    enqueue,
    flushAll,
    discard,
    pendingCount: () => queue.length
  };
}
