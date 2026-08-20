import { describe, expect, test, vi } from 'vitest';

import { createWeakGenerationCache } from './weak-generation-cache';

describe('shared/weak-generation-cache', () => {
  test('computes once per object within a generation', () => {
    const compute = vi.fn((input: { value: string }) => input.value.toUpperCase());
    const cache = createWeakGenerationCache(compute);
    const input = { value: 'message' };

    expect(cache.get(input, 1)).toBe('MESSAGE');
    expect(cache.get(input, 1)).toBe('MESSAGE');
    expect(compute).toHaveBeenCalledOnce();
  });

  test('recomputes after the generation changes', () => {
    const compute = vi.fn((input: { value: number }) => input.value * 2);
    const cache = createWeakGenerationCache(compute);
    const input = { value: 2 };

    expect(cache.get(input, 1)).toBe(4);
    input.value = 3;
    expect(cache.get(input, 2)).toBe(6);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
