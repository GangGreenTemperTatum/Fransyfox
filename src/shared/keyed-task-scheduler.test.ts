import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createKeyedTaskScheduler } from './keyed-task-scheduler';

describe('shared/keyed-task-scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('coalesces repeated work for one key', async () => {
    const run = vi.fn();
    const scheduler = createKeyedTaskScheduler({ delayMs: 200, run });

    expect(scheduler.schedule(7)).toBe(true);
    expect(scheduler.schedule(7)).toBe(false);
    expect(scheduler.schedule(7)).toBe(false);
    expect(scheduler.isScheduled(7)).toBe(true);

    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(7);
    expect(scheduler.isScheduled(7)).toBe(false);
  });

  test('schedules different keys independently', async () => {
    const run = vi.fn();
    const scheduler = createKeyedTaskScheduler({ delayMs: 100, run });

    scheduler.schedule(1);
    scheduler.schedule(2);
    await vi.advanceTimersByTimeAsync(100);

    expect(run.mock.calls).toEqual([[1], [2]]);
  });

  test('cancels pending work for a removed key', async () => {
    const run = vi.fn();
    const scheduler = createKeyedTaskScheduler({ delayMs: 100, run });

    scheduler.schedule(3);
    expect(scheduler.cancel(3)).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(run).not.toHaveBeenCalled();
  });

  test('reports task failures without leaving the key scheduled', async () => {
    const failure = new Error('refresh failed');
    const onError = vi.fn();
    const scheduler = createKeyedTaskScheduler({
      delayMs: 50,
      run: () => {
        throw failure;
      },
      onError
    });

    scheduler.schedule(4);
    await vi.advanceTimersByTimeAsync(50);

    expect(onError).toHaveBeenCalledWith(failure, 4);
    expect(scheduler.isScheduled(4)).toBe(false);
  });
});
