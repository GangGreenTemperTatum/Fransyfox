export interface KeyedTaskScheduler<K> {
  schedule(key: K): boolean;
  cancel(key: K): boolean;
  cancelAll(): void;
  isScheduled(key: K): boolean;
}

/** Coalesces repeated work independently per key within a fixed delay window. */
export function createKeyedTaskScheduler<K>(options: {
  delayMs: number;
  run: (key: K) => void | Promise<void>;
  onError?: (error: unknown, key: K) => void;
}): KeyedTaskScheduler<K> {
  const timers = new Map<K, ReturnType<typeof setTimeout>>();
  const delayMs = Math.max(0, options.delayMs);

  function schedule(key: K): boolean {
    if (timers.has(key)) return false;
    const timer = setTimeout(() => {
      timers.delete(key);
      void Promise.resolve()
        .then(() => options.run(key))
        .catch((error: unknown) => {
          options.onError?.(error, key);
        });
    }, delayMs);
    timers.set(key, timer);
    return true;
  }

  function cancel(key: K): boolean {
    const timer = timers.get(key);
    if (!timer) return false;
    clearTimeout(timer);
    timers.delete(key);
    return true;
  }

  function cancelAll(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  return {
    schedule,
    cancel,
    cancelAll,
    isScheduled: (key: K) => timers.has(key)
  };
}
