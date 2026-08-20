import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createTimedEventBatcher, type EventBatch } from './event-batcher';

describe('shared/event-batcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const batches: Array<EventBatch<number>> = [];
    const batcher = createTimedEventBatcher<number>({
      flushIntervalMs: 100,
      maxBatchSize: 50,
      hardCap: 500,
      onBatch: (batch) => batches.push(batch)
    });
    return { batcher, batches };
  }

  test('rate-limits protected traffic to one batch per interval', async () => {
    const { batcher, batches } = setup();
    for (let i = 0; i < 120; i += 1) batcher.enqueue(i, true);

    expect(batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(batches.map((batch) => batch.events.length)).toEqual([50]);
    await vi.advanceTimersByTimeAsync(200);
    expect(batches.map((batch) => batch.events.length)).toEqual([50, 50, 20]);
    expect(batches.flatMap((batch) => batch.events)).toEqual(
      Array.from({ length: 120 }, (_unused, index) => index)
    );
  });

  test('caps the protected queue and reports overflow drops', async () => {
    const { batcher, batches } = setup();
    let accepted = 0;
    for (let i = 0; i < 600; i += 1) {
      if (batcher.enqueue(i, true)) accepted += 1;
    }

    expect(accepted).toBe(500);
    expect(batcher.pendingCount()).toBe(500);
    await vi.advanceTimersByTimeAsync(100);
    expect(batches[0].events).toHaveLength(50);
    expect(batches[0].dropped).toBe(100);
  });

  test('keeps immediate capture-all batching when protection is disabled', async () => {
    const { batcher, batches } = setup();
    for (let i = 0; i < 120; i += 1) batcher.enqueue(i, false);

    expect(batches.map((batch) => batch.events.length)).toEqual([50, 50]);
    expect(batcher.pendingCount()).toBe(20);
    await vi.advanceTimersByTimeAsync(100);
    expect(batches.map((batch) => batch.events.length)).toEqual([50, 50, 20]);
  });

  test('flushes the complete bounded tail before navigation', () => {
    const { batcher, batches } = setup();
    for (let i = 0; i < 550; i += 1) batcher.enqueue(i, true);

    batcher.flushAll();
    expect(batches).toHaveLength(1);
    expect(batches[0].events).toHaveLength(500);
    expect(batches[0].dropped).toBe(50);
    expect(batcher.pendingCount()).toBe(0);
  });
});
