export interface StableWrapperRegistry<T extends object> {
  getOrCreate(identity: T, delegate?: T): T;
  resolve(identity: T): T;
}

/**
 * Keeps API-visible listener identity stable while allowing a wrapper to
 * delegate to a separately unwrapped function. Weak keys ensure the registry
 * does not keep page listeners alive after the page releases them.
 */
export function createStableWrapperRegistry<T extends object>(
  createWrapper: (delegate: T) => T
): StableWrapperRegistry<T> {
  const wrappers = new WeakMap<T, T>();

  return {
    getOrCreate(identity: T, delegate: T = identity): T {
      const existing = wrappers.get(identity);
      if (existing) return existing;

      const wrapped = createWrapper(delegate);
      wrappers.set(identity, wrapped);
      // Passing an already wrapped listener through the hook must not create
      // another wrapper layer.
      wrappers.set(wrapped, wrapped);
      return wrapped;
    },

    resolve(identity: T): T {
      return wrappers.get(identity) || identity;
    }
  };
}
