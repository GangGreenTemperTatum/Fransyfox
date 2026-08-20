import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import './event-store';

describe('shared/event-store', () => {
  test('stores events in a bounded buffer', () => {
    const storeFactory = (globalThis as {
      FransceiverEventStore?: { createEventStore: (options?: { maxEvents?: number }) => { add: (event: { ts?: number }) => unknown; all: () => unknown[] } };
    }).FransceiverEventStore;

    const store = storeFactory?.createEventStore({ maxEvents: 2 });
    store?.add({ ts: 1 });
    store?.add({ ts: 2 });
    store?.add({ ts: 3 });

    const all = store?.all() || [];
    expect(all.length).toBe(2);
  });

  test('hydrates persistent events and keeps ids monotonic', async () => {
    let snapshot: unknown = null;
    const adapter = {
      load: () => Promise.resolve(snapshot as never),
      save: (nextSnapshot: unknown) => {
        snapshot = nextSnapshot;
        return Promise.resolve();
      }
    };
    const storeFactory = (globalThis as {
      FransceiverEventStore?: {
        createPersistentEventStore: (options?: {
          maxEvents?: number;
          adapter?: typeof adapter;
          saveDelayMs?: number;
        }) => {
          init: () => Promise<void>;
          add: (event: { ts?: number; tabId?: number }) => Promise<{ event: { id?: number }; version: number } | null>;
          all: () => Promise<Array<{ id?: number }>>;
          clearTab: (tabId: number) => Promise<{ clearedCount: number; version: number }>;
          flushNow: () => Promise<void>;
        };
      };
    }).FransceiverEventStore;

    const firstStore = storeFactory?.createPersistentEventStore({
      maxEvents: 5,
      adapter,
      saveDelayMs: 0
    });
    await firstStore?.init();
    const first = await firstStore?.add({ ts: 1, tabId: 1 });
    const second = await firstStore?.add({ ts: 2, tabId: 1 });
    await firstStore?.clearTab(1);
    const third = await firstStore?.add({ ts: 3, tabId: 1 });
    await firstStore?.flushNow();

    expect(first?.event.id).toBe(1);
    expect(second?.event.id).toBe(2);
    expect(third?.event.id).toBe(3);

    const secondStore = storeFactory?.createPersistentEventStore({
      maxEvents: 5,
      adapter,
      saveDelayMs: 0
    });
    await secondStore?.init();
    const hydrated = await secondStore?.all();
    expect(hydrated?.map((event) => event.id)).toEqual([3]);
  });

  test('advances navigation ids and evicts oldest persistent messages', async () => {
    let snapshot: unknown = null;
    const adapter = {
      load: () => Promise.resolve(snapshot as never),
      save: (nextSnapshot: unknown) => {
        snapshot = nextSnapshot;
        return Promise.resolve();
      }
    };
    const storeFactory = (globalThis as {
      FransceiverEventStore?: {
        createPersistentEventStore: (options?: {
          maxEvents?: number;
          adapter?: typeof adapter;
          saveDelayMs?: number;
        }) => {
          init: () => Promise<void>;
          add: (event: { ts?: number; tabId?: number }) => Promise<{ evicted: Array<{ id?: number }> } | null>;
          all: () => Promise<Array<{ id?: number }>>;
          advanceNavigation: (tabId: number) => Promise<{ navigationId: number }>;
          getNavigationId: (tabId: number) => number;
        };
      };
    }).FransceiverEventStore;

    const store = storeFactory?.createPersistentEventStore({ maxEvents: 2, adapter, saveDelayMs: 0 });
    await store?.init();
    expect(store?.getNavigationId(7)).toBe(1);
    await store?.advanceNavigation(7);
    expect(store?.getNavigationId(7)).toBe(2);
    await store?.add({ ts: 1, tabId: 7 });
    await store?.add({ ts: 2, tabId: 7 });
    const third = await store?.add({ ts: 3, tabId: 7 });
    const all = await store?.all();

    expect(third?.evicted.map((event) => event.id)).toEqual([1]);
    expect(all?.map((event) => event.id)).toEqual([2, 3]);
  });

  test('keeps eviction order/ids across many adds (offset buffer)', async () => {
    const adapter = {
      load: () => Promise.resolve(null as never),
      save: () => Promise.resolve()
    };
    const storeFactory = (globalThis as {
      FransceiverEventStore?: {
        createPersistentEventStore: (options?: {
          maxEvents?: number;
          adapter?: typeof adapter;
          saveDelayMs?: number;
        }) => {
          init: () => Promise<void>;
          add: (event: { ts?: number; tabId?: number }) => Promise<{
            event: { id?: number };
            evicted: Array<{ id?: number }>;
            fromVersion: number;
            version: number;
          } | null>;
          all: () => Promise<Array<{ id?: number }>>;
          size: () => number;
        };
      };
    }).FransceiverEventStore;

    const store = storeFactory?.createPersistentEventStore({ maxEvents: 3, adapter, saveDelayMs: 0 });
    await store?.init();
    const evictedIds: number[] = [];
    const incrementallyMirroredIds: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const result = await store?.add({ ts: i + 1, tabId: 1 });
      expect(result?.fromVersion).toBe(i);
      expect(result?.version).toBe(i + 1);
      if (typeof result?.event.id === 'number') {
        incrementallyMirroredIds.push(result.event.id);
        if (incrementallyMirroredIds.length > 3) {
          incrementallyMirroredIds.splice(0, incrementallyMirroredIds.length - 3);
        }
      }
      for (const evicted of result?.evicted || []) {
        if (typeof evicted.id === 'number') evictedIds.push(evicted.id);
      }
    }
    expect(store?.size()).toBe(3);
    const all = await store?.all();
    expect(all?.map((event) => event.id)).toEqual([48, 49, 50]);
    expect(incrementallyMirroredIds).toEqual(all?.map((event) => event.id));
    expect(evictedIds).toEqual(Array.from({ length: 47 }, (_unused, i) => i + 1));
  });

  test('bounds total retained message data and reports payload-budget evictions', async () => {
    const adapter = {
      load: () => Promise.resolve(null as never),
      save: () => Promise.resolve()
    };
    const storeFactory = (globalThis as {
      FransceiverEventStore?: {
        createPersistentEventStore: (options?: {
          maxEvents?: number;
          maxDataChars?: number;
          adapter?: typeof adapter;
          saveDelayMs?: number;
        }) => {
          init: () => Promise<void>;
          add: (event: { dataText: string }) => Promise<{
            event: { id?: number; dataText?: string; dataTruncated?: boolean; dataLength?: number };
            evicted: Array<{ id?: number }>;
          } | null>;
          all: () => Promise<Array<{ id?: number; dataText?: string }>>;
          getMaxDataChars: () => number;
        };
      };
    }).FransceiverEventStore;

    const store = storeFactory?.createPersistentEventStore({
      maxEvents: 100,
      maxDataChars: 10,
      adapter,
      saveDelayMs: 0
    });
    await store?.init();
    await store?.add({ dataText: '123456' });
    const second = await store?.add({ dataText: 'abcdef' });

    expect(store?.getMaxDataChars()).toBe(10);
    expect(second?.evicted.map((event) => event.id)).toEqual([1]);
    expect((await store?.all())?.map((event) => event.dataText)).toEqual(['abcdef']);

    const oversized = await store?.add({ dataText: 'x'.repeat(20) });
    expect(oversized?.event.dataText).toHaveLength(10);
    expect(oversized?.event.dataTruncated).toBe(true);
    expect(oversized?.event.dataLength).toBe(20);
    expect((await store?.all())?.map((event) => event.dataText)).toEqual(['x'.repeat(10)]);
  });

  test('continues saving after one adapter write fails', async () => {
    let saveAttempts = 0;
    let savedEventIds: Array<number | undefined> = [];
    const adapter = {
      load: () => Promise.resolve(null),
      save: (snapshot: { events?: Array<{ id?: number }> }) => {
        saveAttempts += 1;
        if (saveAttempts === 1) {
          return Promise.reject(new Error('temporary IndexedDB failure'));
        }
        savedEventIds = (snapshot.events || []).map((event) => event.id);
        return Promise.resolve();
      }
    };
    const storeFactory = (globalThis as {
      FransceiverEventStore?: {
        createPersistentEventStore: (options: {
          adapter: typeof adapter;
          saveDelayMs: number;
        }) => {
          init: () => Promise<void>;
          add: (event: { ts: number }) => Promise<unknown>;
          flushNow: () => Promise<void>;
        };
      };
    }).FransceiverEventStore;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = storeFactory?.createPersistentEventStore({ adapter, saveDelayMs: 1000 });

    await store?.init();
    await store?.add({ ts: 1 });
    await expect(store?.flushNow()).rejects.toThrow('temporary IndexedDB failure');

    await store?.add({ ts: 2 });
    await expect(store?.flushNow()).resolves.toBeUndefined();

    expect(saveAttempts).toBe(2);
    expect(savedEventIds).toEqual([1, 2]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  describe('save throttling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test('saves at least every saveDelayMs under continuous adds', async () => {
      let saveCount = 0;
      const adapter = {
        load: () => Promise.resolve(null as never),
        save: () => {
          saveCount += 1;
          return Promise.resolve();
        }
      };
      const storeFactory = (globalThis as {
        FransceiverEventStore?: {
          createPersistentEventStore: (options?: {
            maxEvents?: number;
            adapter?: typeof adapter;
            saveDelayMs?: number;
          }) => {
            init: () => Promise<void>;
            add: (event: { ts?: number }) => Promise<unknown>;
          };
        };
      }).FransceiverEventStore;

      const store = storeFactory?.createPersistentEventStore({ maxEvents: 100, adapter, saveDelayMs: 1000 });
      await store?.init();

      // Continuous adds every 100ms for 5 simulated seconds. A pure debounce
      // would keep resetting and never save; the throttle must keep flushing.
      for (let i = 0; i < 50; i += 1) {
        await store?.add({ ts: i + 1 });
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(saveCount).toBeGreaterThanOrEqual(4);
    });
  });
});
