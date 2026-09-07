import { describe, expect, test } from 'vitest';

import { TabSnapshotCache } from './tab-snapshot-cache';

describe('TabSnapshotCache', () => {
  test('evicts a closed tab and rejects its late state update', () => {
    const cache = new TabSnapshotCache<string[]>();
    cache.set(7, ['captured listener']);

    cache.remove(7);
    const accepted = cache.setIfKnownOrCurrent(7, 8, ['late listener']);

    expect(accepted).toBe(false);
    expect(cache.get(7)).toBeUndefined();
  });

  test('keeps a known inactive tab refreshed for instant tab switching', () => {
    const cache = new TabSnapshotCache<string[]>();
    cache.set(7, ['old listener']);

    const accepted = cache.setIfKnownOrCurrent(7, 8, ['fresh listener']);

    expect(accepted).toBe(true);
    expect(cache.get(7)).toEqual(['fresh listener']);
  });

  test('accepts a new snapshot for the current tab after a tab ID is reused', () => {
    const cache = new TabSnapshotCache<string[]>();
    cache.set(7, ['old listener']);
    cache.remove(7);

    const accepted = cache.setIfKnownOrCurrent(7, 7, ['new listener']);

    expect(accepted).toBe(true);
    expect(cache.get(7)).toEqual(['new listener']);
  });

  test('releases all retained snapshots on panel teardown', () => {
    const cache = new TabSnapshotCache<string[]>();
    cache.set(7, ['listener A']);
    cache.set(8, ['listener B']);

    cache.clear();

    expect(cache.get(7)).toBeUndefined();
    expect(cache.get(8)).toBeUndefined();
  });
});
