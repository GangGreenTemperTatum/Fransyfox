export interface WeakGenerationCache<K extends object, V> {
  get(key: K, generation: number): V;
}

/** Caches one derived value per object and invalidates it by generation. */
export function createWeakGenerationCache<K extends object, V>(
  compute: (key: K) => V
): WeakGenerationCache<K, V> {
  const cache = new WeakMap<K, { generation: number; value: V }>();

  return {
    get(key: K, generation: number): V {
      const existing = cache.get(key);
      if (existing && existing.generation === generation) {
        return existing.value;
      }
      const value = compute(key);
      cache.set(key, { generation, value });
      return value;
    }
  };
}
