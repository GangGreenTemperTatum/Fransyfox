(() => {
  'use strict';

  type EventRecord = {
    id?: number;
    ts?: number;
    tabId?: number | null;
    navigationId?: number | null;
    [key: string]: unknown;
  };

  type EventStoreSnapshot = {
    events?: EventRecord[];
    nextId?: number;
    version?: number;
    tabNavigationIds?: Record<string, number>;
  };

  type PersistentStoreAdapter = {
    load: () => Promise<EventStoreSnapshot | null>;
    save: (snapshot: EventStoreSnapshot) => Promise<void>;
  };

  type PersistentAddResult = {
    event: EventRecord;
    evicted: EventRecord[];
    fromVersion: number;
    version: number;
  };

  type PersistentClearResult = {
    clearedCount: number;
    version: number;
  };

  type PersistentNavigationResult = {
    navigationId: number;
    version: number;
  };

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function cloneEvent(event: EventRecord): EventRecord {
    return Object.assign({}, event);
  }

  function normalizeEvents(value: unknown): EventRecord[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((event): event is EventRecord => isRecord(event))
      .map((event) => cloneEvent(event));
  }

  function normalizeNavigationIds(value: unknown): Record<string, number> {
    const normalized: Record<string, number> = {};
    if (!isRecord(value)) return normalized;
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'number' && Number.isFinite(entry) && entry > 0) {
        normalized[key] = Math.floor(entry);
      }
    }
    return normalized;
  }

  function createNoopAdapter(): PersistentStoreAdapter {
    return {
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(undefined)
    };
  }

  function createIndexedDbSnapshotAdapter(options?: {
    databaseName?: string | undefined;
    storeName?: string | undefined;
    snapshotKey?: string | undefined;
  }): PersistentStoreAdapter | null {
    if (typeof indexedDB === 'undefined') {
      return null;
    }

    const databaseName = options?.databaseName || 'FransyfoxEventStore';
    const storeName = options?.storeName || 'snapshots';
    const snapshotKey = options?.snapshotKey || 'messages';
    let dbPromise: Promise<IDBDatabase> | null = null;

    function openDb(): Promise<IDBDatabase> {
      if (dbPromise) return dbPromise;

      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName, { keyPath: 'key' });
          }
        };
        request.onerror = () => {
          reject(request.error || new Error('Failed to open Fransyfox event store'));
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
      });
      dbPromise = opening;
      // A transient open failure must not permanently poison this adapter.
      void opening.catch(() => {
        if (dbPromise === opening) {
          dbPromise = null;
        }
      });

      return dbPromise;
    }

    return {
      load: async () => {
        const db = await openDb();
        return new Promise<EventStoreSnapshot | null>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const request = store.get(snapshotKey);
          request.onerror = () => reject(request.error || new Error('Failed to load event snapshot'));
          request.onsuccess = () => {
            const result = isRecord(request.result) ? request.result : null;
            const snapshot = result && isRecord(result.snapshot) ? result.snapshot : null;
            resolve(snapshot);
          };
        });
      },
      save: async (snapshot: EventStoreSnapshot) => {
        const db = await openDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const request = store.put({ key: snapshotKey, snapshot });
          request.onerror = () => reject(request.error || new Error('Failed to save event snapshot'));
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('Failed to commit event snapshot'));
        });
      }
    };
  }

  function createEventStore(options?: { maxEvents?: number }) {
    const maxEvents = (options && options.maxEvents) || 5000;
    const buffer: Array<EventRecord | undefined> = new Array<EventRecord | undefined>(maxEvents);
    let head = 0;
    let count = 0;
    let nextId = 1;

    function add(event: EventRecord | null | undefined): EventRecord | null {
      if (!event) return null;
      const stored: EventRecord = Object.assign({}, event, {
        id: nextId++,
        ts: event.ts || Date.now()
      });
      buffer[head] = stored;
      head = (head + 1) % maxEvents;
      if (count < maxEvents) {
        count += 1;
      }
      return stored;
    }

    function all(): EventRecord[] {
      if (count === 0) return [];
      if (count < maxEvents) {
        return buffer.slice(0, count).filter((event): event is EventRecord => event !== undefined);
      }
      const result: EventRecord[] = [];
      for (let i = 0; i < count; i += 1) {
        const event = buffer[(head + i) % maxEvents];
        if (event) {
          result.push(event);
        }
      }
      return result;
    }

    function clear(): void {
      head = 0;
      count = 0;
      nextId = 1;
    }

    function size(): number {
      return count;
    }

    function exportJson(): string {
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          count,
          events: all()
        },
        null,
        2
      );
    }

    return {
      add,
      all,
      clear,
      size,
      exportJson
    };
  }

  function createPersistentEventStore(options?: {
    maxEvents?: number;
    maxDataChars?: number;
    databaseName?: string;
    storeName?: string;
    snapshotKey?: string;
    adapter?: PersistentStoreAdapter;
    saveDelayMs?: number;
  }) {
    const maxEvents = options?.maxEvents || 5000;
    const maxDataChars =
      typeof options?.maxDataChars === 'number' && Number.isFinite(options.maxDataChars)
        ? Math.max(1, Math.floor(options.maxDataChars))
        : Number.POSITIVE_INFINITY;
    const adapter =
      options?.adapter ||
      createIndexedDbSnapshotAdapter({
        databaseName: options?.databaseName,
        storeName: options?.storeName,
        snapshotKey: options?.snapshotKey
      }) ||
      createNoopAdapter();
    const saveDelayMs = typeof options?.saveDelayMs === 'number' ? options.saveDelayMs : 150;

    let events: EventRecord[] = [];
    // Logical start of the buffer. Eviction advances the offset instead of
    // shifting the array (shift() is an O(maxEvents) memmove per message once
    // the buffer is full); the array is compacted in amortized O(1).
    let startIndex = 0;
    const COMPACT_THRESHOLD = 1024;
    let nextId = 1;
    let version = 0;
    let liveDataChars = 0;
    let tabNavigationIds: Record<string, number> = {};
    let loaded = false;
    let hydrated = false;
    let initPromise: Promise<void> | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSaveTime = 0;
    let savePromise = Promise.resolve();

    function liveEvents(): EventRecord[] {
      return startIndex > 0 ? events.slice(startIndex) : events;
    }

    function buildSnapshot(): EventStoreSnapshot {
      // Stored events are never mutated after add() and IndexedDB
      // structured-clones on write, so the snapshot can reference them
      // directly - no per-event clone of the whole buffer.
      return {
        events: liveEvents().slice(),
        nextId,
        version,
        tabNavigationIds: Object.assign({}, tabNavigationIds)
      };
    }

    function eventDataChars(event: EventRecord | undefined): number {
      return event && typeof event.dataText === 'string' ? event.dataText.length : 0;
    }

    function capEventDataText(event: EventRecord): EventRecord {
      if (!Number.isFinite(maxDataChars) || typeof event.dataText !== 'string' || event.dataText.length <= maxDataChars) {
        return event;
      }
      const originalLength = event.dataText.length;
      event.dataText = event.dataText.slice(0, maxDataChars);
      event.dataTruncated = true;
      if (typeof event.dataLength !== 'number') event.dataLength = originalLength;
      return event;
    }

    function sortAndTrimLoadedEvents(loadedEvents: EventRecord[]): EventRecord[] {
      const sorted = loadedEvents
        .filter((event) => typeof event.id === 'number' && Number.isFinite(event.id))
        .sort((left, right) => Number(left.id) - Number(right.id))
        .map(capEventDataText);
      const retained: EventRecord[] = [];
      let retainedChars = 0;
      for (let i = sorted.length - 1; i >= 0 && retained.length < maxEvents; i -= 1) {
        const event = sorted[i];
        const size = eventDataChars(event);
        if (retained.length > 0 && retainedChars + size > maxDataChars) break;
        retained.push(event);
        retainedChars += size;
      }
      return retained.reverse();
    }

    function recomputeNextId(snapshotNextId: unknown): void {
      let maxId = 0;
      for (const event of events) {
        const id = event.id;
        if (typeof id === 'number' && Number.isFinite(id)) {
          maxId = Math.max(maxId, id);
        }
      }
      const persistedNextId =
        typeof snapshotNextId === 'number' && Number.isFinite(snapshotNextId)
          ? Math.floor(snapshotNextId)
          : 1;
      nextId = Math.max(persistedNextId, maxId + 1, 1);
    }

    // Trailing throttle, not a debounce: under continuous traffic a debounce
    // keeps resetting and may never persist; this guarantees a save at most
    // (and at least) every saveDelayMs while changes keep arriving.
    function scheduleSave(): void {
      if (!loaded) return;
      if (saveTimer) return;
      const delay = Math.max(0, saveDelayMs - (Date.now() - lastSaveTime));
      saveTimer = setTimeout(() => {
        saveTimer = null;
        // Scheduled writes have no caller to observe a rejection. The save
        // queue logs it and remains usable for the next scheduled attempt.
        void flushNow().catch(() => undefined);
      }, delay);
    }

    async function flushNow(): Promise<void> {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (!loaded) return;
      lastSaveTime = Date.now();
      const snapshot = buildSnapshot();
      const operation = savePromise.then(() => adapter.save(snapshot));
      // Keep the internal queue resolved after a failed operation so later
      // snapshots still run. Await the original operation so explicit callers
      // can observe whether their own flush succeeded.
      savePromise = operation.catch((error: unknown) => {
        console.warn('Fransyfox: Failed to persist message event store:', error);
      });
      await operation;
    }

    async function init(): Promise<void> {
      if (loaded) return;
      if (initPromise) return initPromise;
      initPromise = (async () => {
        try {
          const snapshot = await adapter.load();
          if (snapshot) {
            events = sortAndTrimLoadedEvents(normalizeEvents(snapshot.events));
            startIndex = 0;
            liveDataChars = events.reduce((sum, event) => sum + eventDataChars(event), 0);
            version =
              typeof snapshot.version === 'number' && Number.isFinite(snapshot.version)
                ? Math.max(0, Math.floor(snapshot.version))
                : 0;
            tabNavigationIds = normalizeNavigationIds(snapshot.tabNavigationIds);
            recomputeNextId(snapshot.nextId);
            hydrated = events.length > 0;
          }
        } catch (error) {
          console.warn('Fransyfox: Failed to hydrate message event store:', error);
        } finally {
          loaded = true;
        }
      })();
      return initPromise;
    }

    async function add(event: EventRecord | null | undefined): Promise<PersistentAddResult | null> {
      await init();
      if (!event) return null;
      const fromVersion = version;
      const stored: EventRecord = capEventDataText(Object.assign({}, event, {
        id: nextId++,
        ts: event.ts || Date.now()
      }));
      events.push(stored);
      liveDataChars += eventDataChars(stored);

      const evicted: EventRecord[] = [];
      while (events.length - startIndex > maxEvents || liveDataChars > maxDataChars) {
        const removed = events[startIndex];
        events[startIndex] = undefined as unknown as EventRecord;
        startIndex += 1;
        if (removed) {
          liveDataChars -= eventDataChars(removed);
          evicted.push(removed);
        }
      }
      if (startIndex > COMPACT_THRESHOLD) {
        events = events.slice(startIndex);
        startIndex = 0;
      }

      version += 1;
      scheduleSave();
      return {
        event: cloneEvent(stored),
        evicted: evicted.map(cloneEvent),
        fromVersion,
        version
      };
    }

    async function all(): Promise<EventRecord[]> {
      await init();
      return liveEvents().map(cloneEvent);
    }

    async function clear(): Promise<PersistentClearResult> {
      await init();
      const clearedCount = events.length - startIndex;
      events = [];
      startIndex = 0;
      liveDataChars = 0;
      version += 1;
      scheduleSave();
      return { clearedCount, version };
    }

    async function clearTab(tabId: number | string | null | undefined): Promise<PersistentClearResult> {
      await init();
      const normalizedTabId =
        typeof tabId === 'number' && Number.isFinite(tabId) ? tabId : Number(tabId);
      if (!Number.isFinite(normalizedTabId)) {
        return clear();
      }
      const before = events.length - startIndex;
      events = liveEvents().filter((event) => event.tabId !== normalizedTabId);
      startIndex = 0;
      liveDataChars = events.reduce((sum, event) => sum + eventDataChars(event), 0);
      const clearedCount = before - events.length;
      version += 1;
      scheduleSave();
      return { clearedCount, version };
    }

    async function removeTab(tabId: number | string | null | undefined): Promise<PersistentClearResult> {
      await init();
      const key = String(tabId);
      delete tabNavigationIds[key];
      return clearTab(tabId);
    }

    function getNavigationId(tabId: number | string | null | undefined): number {
      const key = String(tabId);
      return tabNavigationIds[key] || 1;
    }

    async function advanceNavigation(tabId: number | string | null | undefined): Promise<PersistentNavigationResult> {
      await init();
      const key = String(tabId);
      const nextNavigationId = (tabNavigationIds[key] || 1) + 1;
      tabNavigationIds[key] = nextNavigationId;
      version += 1;
      scheduleSave();
      return { navigationId: nextNavigationId, version };
    }

    function size(): number {
      return events.length - startIndex;
    }

    function getVersion(): number {
      return version;
    }

    function getMaxEvents(): number {
      return maxEvents;
    }

    function getMaxDataChars(): number {
      return maxDataChars;
    }

    function wasHydrated(): boolean {
      return hydrated;
    }

    async function exportJson(): Promise<string> {
      await init();
      const live = liveEvents();
      return JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          count: live.length,
          version,
          events: live
        },
        null,
        2
      );
    }

    return {
      init,
      add,
      all,
      clear,
      clearTab,
      removeTab,
      getNavigationId,
      advanceNavigation,
      size,
      getVersion,
      getMaxEvents,
      getMaxDataChars,
      wasHydrated,
      flushNow,
      exportJson
    };
  }

  type FransyfoxEventStoreType = {
    createEventStore: typeof createEventStore;
    createPersistentEventStore: typeof createPersistentEventStore;
  };

  const globalObj = globalThis as typeof globalThis & {
    FransyfoxEventStore?: Partial<FransyfoxEventStoreType>;
  };

  globalObj.FransyfoxEventStore = Object.assign(globalObj.FransyfoxEventStore || {}, {
    createEventStore,
    createPersistentEventStore
  });
})();
